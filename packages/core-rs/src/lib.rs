use std::collections::BTreeSet;
use std::fs::{self, File};
use std::io::BufReader;
use std::panic::{self, AssertUnwindSafe};
use std::path::{Path, PathBuf};

use base64::prelude::{Engine as _, BASE64_STANDARD};
use nd2_rs::Nd2File;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tiff::decoder::{Decoder, DecodingResult};
use walkdir::WalkDir;

const SAMPLE_SIZE: usize = 2048;

#[derive(Clone)]
struct ParsedTiffName {
    channel: u32,
    position: u32,
    time: u32,
    z: u32,
}

#[derive(Serialize)]
struct WorkspaceScan {
    positions: Vec<u32>,
    channels: Vec<u32>,
    times: Vec<u32>,
    #[serde(rename = "zSlices")]
    z_slices: Vec<u32>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum ViewerSource {
    Tif { path: String },
    Nd2 { path: String },
}

#[derive(Clone, Deserialize, Serialize)]
struct FrameRequest {
    pos: u32,
    channel: u32,
    time: u32,
    z: u32,
}

#[derive(Clone, Deserialize, Serialize)]
struct ContrastWindow {
    min: u32,
    max: u32,
}

struct RawFrame {
    width: u32,
    height: u32,
    data: Vec<u16>,
}

#[derive(Serialize)]
struct SaveBboxResponse {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Deserialize)]
struct WsEnvelope {
    id: String,
    #[serde(rename = "type")]
    kind: String,
    payload: Value,
}

#[derive(Serialize)]
struct WsResponseEnvelope<T> {
    id: String,
    #[serde(rename = "type")]
    kind: String,
    payload: T,
}

#[derive(Serialize)]
struct ErrorPayload {
    message: String,
}

#[derive(Deserialize)]
struct ScanSourcePayload {
    source: ViewerSource,
}

#[derive(Deserialize)]
struct LoadFramePayload {
    source: ViewerSource,
    request: FrameRequest,
    contrast: Option<ContrastWindow>,
}

#[derive(Deserialize)]
struct SaveBboxPayload {
    #[serde(rename = "workspacePath")]
    workspace_path: String,
    source: ViewerSource,
    pos: u32,
    csv: String,
}

#[derive(Serialize)]
struct WsFramePayload {
    width: u32,
    height: u32,
    #[serde(rename = "dataBase64")]
    data_base64: String,
    #[serde(rename = "pixelType")]
    pixel_type: &'static str,
    #[serde(rename = "contrastDomain")]
    contrast_domain: ContrastWindow,
    #[serde(rename = "suggestedContrast")]
    suggested_contrast: ContrastWindow,
    #[serde(rename = "appliedContrast")]
    applied_contrast: ContrastWindow,
}

fn parse_pos_dir_name(name: &str) -> Option<u32> {
    let normalized: String = name.chars().filter(|c| !c.is_whitespace()).collect();
    if normalized.is_empty() {
        return None;
    }
    let lower = normalized.to_ascii_lowercase();
    for prefix in ["position", "pos"] {
        if let Some(rest) = lower.strip_prefix(prefix) {
            let trimmed = rest.trim_start_matches(['-', '_']);
            if !trimmed.is_empty() && trimmed.chars().all(|c| c.is_ascii_digit()) {
                return trimmed.parse().ok();
            }
        }
    }
    if lower.chars().all(|c| c.is_ascii_digit()) {
        return lower.parse().ok();
    }
    None
}

fn parse_tiff_name(name: &str) -> Option<ParsedTiffName> {
    let lower = name.to_ascii_lowercase();
    let stem = lower
        .strip_suffix(".tif")
        .or_else(|| lower.strip_suffix(".tiff"))?;
    let rest = stem.strip_prefix("img_channel")?;
    let parts: Vec<&str> = rest.split('_').collect();
    if parts.len() != 4 {
        return None;
    }

    let channel = parts[0].parse().ok()?;
    let position = parts[1].strip_prefix("position")?.parse().ok()?;
    let time = parts[2].strip_prefix("time")?.parse().ok()?;
    let z = parts[3].strip_prefix("z")?.parse().ok()?;
    Some(ParsedTiffName {
        channel,
        position,
        time,
        z,
    })
}

fn collect_tiffs(folder: &Path) -> Vec<(PathBuf, ParsedTiffName)> {
    WalkDir::new(folder)
        .max_depth(6)
        .into_iter()
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_type().is_file())
        .filter_map(|entry| {
            let file_name = entry.path().file_name()?.to_str()?;
            let parsed = parse_tiff_name(file_name)?;
            Some((entry.into_path(), parsed))
        })
        .collect()
}

fn find_position_dir(root: &Path, position: u32) -> Result<PathBuf, String> {
    let entries = fs::read_dir(root).map_err(|err| err.to_string())?;
    for entry in entries.flatten() {
        if !entry.path().is_dir() {
            continue;
        }
        let Some(name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        if parse_pos_dir_name(&name) == Some(position) {
            return Ok(entry.path());
        }
    }
    Err(format!("Position directory not found for Pos{position}"))
}

fn to_u16_buffer(width: u32, height: u32, data: DecodingResult) -> Result<Vec<u16>, String> {
    let expected_len = width as usize * height as usize;
    let collapse_channels = |values: Vec<u16>| -> Result<Vec<u16>, String> {
        if values.len() == expected_len {
            return Ok(values);
        }
        if values.len() == expected_len * 3 || values.len() == expected_len * 4 {
            let channels = values.len() / expected_len;
            let mut collapsed = Vec::with_capacity(expected_len);
            for chunk in values.chunks(channels) {
                let sum: u32 = chunk.iter().map(|value| *value as u32).sum();
                collapsed.push((sum / channels as u32) as u16);
            }
            return Ok(collapsed);
        }
        Err("Unsupported TIFF sample layout".to_string())
    };

    match data {
        DecodingResult::U8(values) => {
            if values.len() == expected_len {
                Ok(values.into_iter().map(|value| value as u16).collect())
            } else if values.len() == expected_len * 3 || values.len() == expected_len * 4 {
                let expanded = values.into_iter().map(|value| value as u16).collect();
                collapse_channels(expanded)
            } else {
                Err("Unsupported TIFF sample layout".to_string())
            }
        }
        DecodingResult::U16(values) => collapse_channels(values),
        _ => Err("Unsupported TIFF pixel type".to_string()),
    }
}

fn load_tiff_frame(path: &Path) -> Result<RawFrame, String> {
    let file = File::open(path).map_err(|err| err.to_string())?;
    let mut decoder = Decoder::new(BufReader::new(file)).map_err(|err| err.to_string())?;
    let dimensions = decoder.dimensions().map_err(|err| err.to_string())?;
    let data = decoder.read_image().map_err(|err| err.to_string())?;
    let pixels = to_u16_buffer(dimensions.0, dimensions.1, data)?;
    Ok(RawFrame {
        width: dimensions.0,
        height: dimensions.1,
        data: pixels,
    })
}

fn workspace_bbox_csv_path(root: &str, pos: u32) -> PathBuf {
    Path::new(root).join("bbox").join(format!("Pos{pos}.csv"))
}

fn dimension_size(sizes: &std::collections::HashMap<String, usize>, key: &str) -> usize {
    sizes.get(key).copied().unwrap_or(1)
}

fn dimension_values(sizes: &std::collections::HashMap<String, usize>, key: &str) -> Vec<u32> {
    (0..dimension_size(sizes, key))
        .filter_map(|value| u32::try_from(value).ok())
        .collect()
}

fn scan_nd2(path: &Path) -> Result<WorkspaceScan, String> {
    let mut nd2 = Nd2File::open(path).map_err(|err| err.to_string())?;
    let sizes = nd2.sizes().map_err(|err| err.to_string())?;
    Ok(WorkspaceScan {
        positions: dimension_values(&sizes, "P"),
        channels: dimension_values(&sizes, "C"),
        times: dimension_values(&sizes, "T"),
        z_slices: dimension_values(&sizes, "Z"),
    })
}

fn scan_tif(root: &Path) -> Result<WorkspaceScan, String> {
    let entries = fs::read_dir(root).map_err(|err| err.to_string())?;
    let mut position_dirs = Vec::<(u32, PathBuf)>::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let Some(name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        if let Some(position) = parse_pos_dir_name(&name) {
            position_dirs.push((position, path));
        }
    }
    position_dirs.sort_by_key(|(position, _)| *position);

    let mut positions = Vec::new();
    let mut channels = BTreeSet::new();
    let mut times = BTreeSet::new();
    let mut z_slices = BTreeSet::new();

    for (position, folder) in position_dirs {
        positions.push(position);
        for (_, parsed) in collect_tiffs(&folder) {
            channels.insert(parsed.channel);
            times.insert(parsed.time);
            z_slices.insert(parsed.z);
        }
    }

    Ok(WorkspaceScan {
        positions,
        channels: channels.into_iter().collect(),
        times: times.into_iter().collect(),
        z_slices: z_slices.into_iter().collect(),
    })
}

fn validate_request_index(label: &str, index: u32, size: usize) -> Result<usize, String> {
    let effective_size = size.max(1);
    let index = index as usize;
    if index >= effective_size {
        return Err(format!("{label} index {index} is out of range"));
    }
    Ok(index)
}

fn load_tif_frame(root: &Path, request: FrameRequest) -> Result<RawFrame, String> {
    let pos_dir = find_position_dir(root, request.pos)?;
    let matching = collect_tiffs(&pos_dir)
        .into_iter()
        .find(|(_, parsed)| {
            parsed.position == request.pos
                && parsed.channel == request.channel
                && parsed.time == request.time
                && parsed.z == request.z
        })
        .map(|(path, _)| path)
        .ok_or_else(|| "Requested TIFF frame not found".to_string())?;
    load_tiff_frame(&matching)
}

fn load_nd2_frame(path: &Path, request: FrameRequest) -> Result<RawFrame, String> {
    let mut nd2 = Nd2File::open(path).map_err(|err| err.to_string())?;
    let sizes = nd2.sizes().map_err(|err| err.to_string())?;
    let width = u32::try_from(dimension_size(&sizes, "X")).map_err(|err| err.to_string())?;
    let height = u32::try_from(dimension_size(&sizes, "Y")).map_err(|err| err.to_string())?;

    let pos = validate_request_index("Position", request.pos, dimension_size(&sizes, "P"))?;
    let time = validate_request_index("Time", request.time, dimension_size(&sizes, "T"))?;
    let channel = validate_request_index("Channel", request.channel, dimension_size(&sizes, "C"))?;
    let z = validate_request_index("Z", request.z, dimension_size(&sizes, "Z"))?;

    let data = nd2
        .read_frame_2d(pos, time, channel, z)
        .map_err(|err| err.to_string())?;

    Ok(RawFrame {
        width,
        height,
        data,
    })
}

fn scan_source(source: ViewerSource) -> Result<WorkspaceScan, String> {
    match source {
        ViewerSource::Tif { path } => scan_tif(Path::new(&path)),
        ViewerSource::Nd2 { path } => scan_nd2(Path::new(&path)),
    }
}

fn load_frame(source: ViewerSource, request: FrameRequest) -> Result<RawFrame, String> {
    match source {
        ViewerSource::Tif { path } => load_tif_frame(Path::new(&path), request),
        ViewerSource::Nd2 { path } => load_nd2_frame(Path::new(&path), request),
    }
}

fn save_bbox(
    workspace_path: String,
    _source: ViewerSource,
    pos: u32,
    csv: String,
) -> SaveBboxResponse {
    let target = workspace_bbox_csv_path(&workspace_path, pos);
    let Some(parent) = target.parent() else {
        return SaveBboxResponse {
            ok: false,
            error: Some("Unable to resolve bbox output directory".to_string()),
        };
    };
    if let Err(error) = fs::create_dir_all(parent) {
        return SaveBboxResponse {
            ok: false,
            error: Some(error.to_string()),
        };
    }

    let normalized = if csv.ends_with('\n') {
        csv
    } else {
        format!("{csv}\n")
    };

    match fs::write(target, normalized) {
        Ok(_) => SaveBboxResponse {
            ok: true,
            error: None,
        },
        Err(error) => SaveBboxResponse {
            ok: false,
            error: Some(error.to_string()),
        },
    }
}

fn contrast_domain() -> ContrastWindow {
    ContrastWindow {
        min: 0,
        max: u16::MAX as u32,
    }
}

fn sampled_values(values: &[u16]) -> Vec<u16> {
    if values.is_empty() {
        return vec![0];
    }
    if values.len() <= SAMPLE_SIZE {
        let mut copy = values.to_vec();
        copy.sort_unstable();
        return copy;
    }

    let step = values.len() as f64 / SAMPLE_SIZE as f64;
    let mut sample = Vec::with_capacity(SAMPLE_SIZE);
    for index in 0..SAMPLE_SIZE {
        let position = (index as f64 * step).floor() as usize;
        sample.push(values[position.min(values.len() - 1)]);
    }
    sample.sort_unstable();
    sample
}

fn percentile(values: &[u16], q: f64) -> u16 {
    if values.is_empty() {
        return 0;
    }
    let sorted = sampled_values(values);
    let clamped_q = q.clamp(0.0, 1.0);
    let index = (clamped_q * (sorted.len().saturating_sub(1)) as f64).floor() as usize;
    sorted[index.min(sorted.len() - 1)]
}

fn auto_contrast(values: &[u16]) -> ContrastWindow {
    if values.is_empty() {
        return ContrastWindow { min: 0, max: 1 };
    }
    let min = percentile(values, 0.001) as u32;
    let max = percentile(values, 0.999) as u32;
    ContrastWindow {
        min,
        max: max.max(min + 1),
    }
}

fn normalize_contrast(contrast: &ContrastWindow) -> ContrastWindow {
    let domain = contrast_domain();
    let min = contrast.min.clamp(domain.min, domain.max.saturating_sub(1));
    let max = contrast.max.clamp(min + 1, domain.max);
    ContrastWindow { min, max }
}

fn apply_contrast(values: &[u16], contrast: &ContrastWindow) -> Vec<u8> {
    let min = contrast.min as f32;
    let max = contrast.max.max(contrast.min + 1) as f32;
    let range = (max - min).max(1.0);

    values
        .iter()
        .map(|value| {
            let normalized = ((*value as f32 - min) / range).clamp(0.0, 1.0);
            (normalized * 255.0).round() as u8
        })
        .collect()
}

fn ok_response<T: Serialize>(id: String, kind: &str, payload: T) -> String {
    serde_json::to_string(&WsResponseEnvelope {
        id,
        kind: kind.to_string(),
        payload,
    })
    .expect("serializing websocket response should succeed")
}

fn error_response(id: String, message: String) -> String {
    ok_response(id, "error", ErrorPayload { message })
}

fn panic_message(payload: Box<dyn std::any::Any + Send>) -> String {
    if let Some(message) = payload.downcast_ref::<&str>() {
        return format!("Backend panic: {message}");
    }
    if let Some(message) = payload.downcast_ref::<String>() {
        return format!("Backend panic: {message}");
    }
    "Backend panic".to_string()
}

fn catch_backend_panic<T, F>(operation: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String>,
{
    match panic::catch_unwind(AssertUnwindSafe(operation)) {
        Ok(result) => result,
        Err(payload) => Err(panic_message(payload)),
    }
}

pub fn handle_ws_request(text: &str) -> Option<String> {
    let envelope: WsEnvelope = serde_json::from_str(text).ok()?;
    let id = envelope.id.clone();

    let response = match envelope.kind.as_str() {
        "scan_source" => {
            let payload = serde_json::from_value::<ScanSourcePayload>(envelope.payload)
                .map_err(|err| err.to_string());
            match catch_backend_panic(|| payload.and_then(|payload| scan_source(payload.source))) {
                Ok(scan) => ok_response(id, "scan_source_result", scan),
                Err(message) => error_response(id, message),
            }
        }
        "load_frame" => {
            let payload = serde_json::from_value::<LoadFramePayload>(envelope.payload)
                .map_err(|err| err.to_string());
            match catch_backend_panic(|| {
                payload.and_then(|payload| {
                    let raw = load_frame(payload.source, payload.request)?;
                    let suggested = auto_contrast(&raw.data);
                    let applied = normalize_contrast(payload.contrast.as_ref().unwrap_or(&suggested));
                    let bytes = apply_contrast(&raw.data, &applied);
                    Ok(WsFramePayload {
                        width: raw.width,
                        height: raw.height,
                        data_base64: BASE64_STANDARD.encode(bytes),
                        pixel_type: "uint8",
                        contrast_domain: contrast_domain(),
                        suggested_contrast: suggested,
                        applied_contrast: applied,
                    })
                })
            }) {
                Ok(frame) => ok_response(id, "load_frame_result", frame),
                Err(message) => error_response(id, message),
            }
        }
        "save_bbox" => {
            let payload = serde_json::from_value::<SaveBboxPayload>(envelope.payload)
                .map_err(|err| err.to_string());
            match payload {
                Ok(payload) => ok_response(
                    id,
                    "save_bbox_result",
                    save_bbox(payload.workspace_path, payload.source, payload.pos, payload.csv),
                ),
                Err(message) => error_response(id, message),
            }
        }
        _ => error_response(id, "Unsupported request type".to_string()),
    };

    Some(response)
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::{
        auto_contrast, catch_backend_panic, parse_pos_dir_name, parse_tiff_name, save_bbox,
        workspace_bbox_csv_path, ContrastWindow, ViewerSource,
    };

    #[test]
    fn parses_position_dir_names() {
        assert_eq!(parse_pos_dir_name("Pos001"), Some(1));
        assert_eq!(parse_pos_dir_name("position-58"), Some(58));
        assert_eq!(parse_pos_dir_name("9"), Some(9));
        assert_eq!(parse_pos_dir_name("misc"), None);
    }

    #[test]
    fn parses_tiff_names() {
        let parsed = parse_tiff_name("img_channel001_position058_time000000003_z004.tif").unwrap();
        assert_eq!(parsed.channel, 1);
        assert_eq!(parsed.position, 58);
        assert_eq!(parsed.time, 3);
        assert_eq!(parsed.z, 4);
    }

    #[test]
    fn auto_contrast_has_nonzero_window() {
        let contrast = auto_contrast(&[0, 1, 2, 3, 4, 5, 65535]);
        assert!(contrast.max > contrast.min);
    }

    #[test]
    fn save_bbox_writes_expected_file_name_with_trailing_newline() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("view-tauri-save-bbox-{unique}"));
        let source = ViewerSource::Tif {
            path: root.join("images").to_string_lossy().to_string(),
        };

        let result = save_bbox(
            root.to_string_lossy().to_string(),
            source.clone(),
            7,
            "crop,x,y,w,h\n0,1,2,3,4".to_string(),
        );
        assert!(result.ok);

        let saved_path = workspace_bbox_csv_path(&root.to_string_lossy(), 7);
        let saved = fs::read_to_string(&saved_path).unwrap();
        assert_eq!(saved, "crop,x,y,w,h\n0,1,2,3,4\n");

        let _ = fs::remove_file(saved_path);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn workspace_bbox_path_uses_bbox_subfolder_and_pos_name() {
        let path = workspace_bbox_csv_path(r"C:\data\workspace", 3);
        assert_eq!(path, PathBuf::from(r"C:\data\workspace\bbox\Pos3.csv"));
    }

    #[test]
    fn contrast_window_normalizes() {
        let window = ContrastWindow { min: 70000, max: 70000 };
        let normalized = super::normalize_contrast(&window);
        assert_eq!(normalized.min, 65534);
        assert_eq!(normalized.max, 65535);
    }

    #[test]
    fn panic_barrier_returns_error_message() {
        let result = catch_backend_panic::<(), _>(|| panic!("nd2 exploded"));
        assert_eq!(result.unwrap_err(), "Backend panic: nd2 exploded");
    }
}
