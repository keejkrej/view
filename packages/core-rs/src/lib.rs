use std::collections::{BTreeSet, HashMap};
use std::fs::{self, File};
use std::io::{BufReader, BufWriter, Cursor};
use std::panic::{self, AssertUnwindSafe};
use std::path::{Path, PathBuf};

use base64::prelude::{Engine as _, BASE64_STANDARD};
use nd2_rs::Nd2File;
use png::{BitDepth, ColorType, Decoder as PngDecoder};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tiff::decoder::{Decoder, DecodingResult};
use tiff::encoder::{colortype, TiffEncoder};
use time::{format_description::well_known::Rfc3339, OffsetDateTime};
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

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum CropOutputFormat {
    Tiff,
}

#[derive(Serialize)]
struct CropRoiResponse {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(rename = "outputPath", skip_serializing_if = "Option::is_none")]
    output_path: Option<String>,
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

#[derive(Serialize)]
struct CropRoiProgressPayload {
    progress: f64,
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

#[derive(Deserialize)]
struct CropRoiPayload {
    #[serde(rename = "workspacePath")]
    workspace_path: String,
    source: ViewerSource,
    pos: u32,
    format: CropOutputFormat,
}

#[derive(Deserialize)]
struct ScanRoiWorkspacePayload {
    #[serde(rename = "workspacePath")]
    workspace_path: String,
}

#[derive(Deserialize)]
struct LoadAnnotationLabelsPayload {
    #[serde(rename = "workspacePath")]
    workspace_path: String,
}

#[derive(Clone, Deserialize, Serialize)]
struct RoiFrameRequest {
    pos: u32,
    roi: u32,
    channel: u32,
    time: u32,
    z: u32,
}

#[derive(Deserialize)]
struct LoadRoiFramePayload {
    #[serde(rename = "workspacePath")]
    workspace_path: String,
    request: RoiFrameRequest,
    contrast: Option<ContrastWindow>,
}

#[derive(Deserialize)]
struct LoadRoiFrameAnnotationPayload {
    #[serde(rename = "workspacePath")]
    workspace_path: String,
    request: RoiFrameRequest,
}

#[derive(Deserialize)]
struct SaveRoiFrameAnnotationPayload {
    #[serde(rename = "workspacePath")]
    workspace_path: String,
    request: RoiFrameRequest,
    annotation: RoiFrameAnnotationPayload,
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

#[derive(Clone, Deserialize, Serialize)]
struct RoiBbox {
    roi: u32,
    x: u32,
    y: u32,
    w: u32,
    h: u32,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RoiIndexEntry {
    roi: u32,
    file_name: String,
    bbox: RoiBbox,
    shape: [u32; 5],
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RoiIndexFile {
    position: u32,
    axis_order: String,
    page_order: Vec<String>,
    time_count: u32,
    channel_count: u32,
    z_count: u32,
    source: ViewerSource,
    rois: Vec<RoiIndexEntry>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RoiPositionScan {
    pos: u32,
    source: ViewerSource,
    channels: Vec<u32>,
    times: Vec<u32>,
    #[serde(rename = "zSlices")]
    z_slices: Vec<u32>,
    rois: Vec<RoiIndexEntry>,
}

#[derive(Serialize)]
struct RoiWorkspaceScan {
    positions: Vec<RoiPositionScan>,
}

#[derive(Clone, Deserialize, Serialize)]
struct AnnotationLabel {
    id: String,
    name: String,
    color: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct RoiFrameAnnotation {
    classification_label_id: Option<String>,
    mask_path: Option<String>,
    updated_at: Option<String>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RoiFrameAnnotationPayload {
    classification_label_id: Option<String>,
    mask_base64_png: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LoadedRoiFrameAnnotation {
    annotation: RoiFrameAnnotation,
    mask_base64_png: Option<String>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum AnnotationLabelsFile {
    Wrapped { labels: Vec<AnnotationLabel> },
    Array(Vec<AnnotationLabel>),
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct RoiFrameAnnotationFile {
    #[serde(default = "annotation_schema_version")]
    schema_version: u32,
    classification_label_id: Option<String>,
    mask_file_name: Option<String>,
    updated_at: String,
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
    load_tiff_frame_page(path, 0)
}

fn load_tiff_frame_page(path: &Path, page: usize) -> Result<RawFrame, String> {
    let file = File::open(path).map_err(|err| err.to_string())?;
    let mut decoder = Decoder::new(BufReader::new(file)).map_err(|err| err.to_string())?;
    for page_idx in 0..page {
        if !decoder.more_images() {
            return Err(format!(
                "TIFF page {} is out of range for {}",
                page_idx + 1,
                path.display()
            ));
        }
        decoder.next_image().map_err(|err| err.to_string())?;
    }
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

fn workspace_roi_pos_dir_path(root: &str, pos: u32) -> PathBuf {
    Path::new(root).join("roi").join(format!("Pos{pos}"))
}

fn workspace_roi_tiff_path(root: &str, pos: u32, roi: u32) -> PathBuf {
    workspace_roi_pos_dir_path(root, pos).join(format!("Roi{roi}.tif"))
}

fn workspace_roi_index_path(root: &str, pos: u32) -> PathBuf {
    workspace_roi_pos_dir_path(root, pos).join("index.json")
}

fn workspace_annotations_dir_path(root: &str) -> PathBuf {
    Path::new(root).join("annotations")
}

fn workspace_annotation_labels_path(root: &str) -> PathBuf {
    workspace_annotations_dir_path(root).join("labels.json")
}

fn workspace_annotation_roi_dir_path(root: &str, request: &RoiFrameRequest) -> PathBuf {
    workspace_annotations_dir_path(root)
        .join("roi")
        .join(format!("Pos{}", request.pos))
        .join(format!("Roi{}", request.roi))
}

fn annotation_frame_stem(request: &RoiFrameRequest) -> String {
    format!(
        "C{}_T{}_Z{}",
        request.channel, request.time, request.z
    )
}

fn workspace_annotation_json_path(root: &str, request: &RoiFrameRequest) -> PathBuf {
    workspace_annotation_roi_dir_path(root, request).join(format!("{}.json", annotation_frame_stem(request)))
}

fn workspace_annotation_mask_path(root: &str, request: &RoiFrameRequest) -> PathBuf {
    workspace_annotation_roi_dir_path(root, request).join(format!("{}.png", annotation_frame_stem(request)))
}

fn annotation_schema_version() -> u32 {
    1
}

fn path_to_forward_slash_string(path: &Path) -> String {
    path.to_string_lossy().replace('\\', "/")
}

fn workspace_relative_path(root: &str, path: &Path) -> String {
    path.strip_prefix(root)
        .map(path_to_forward_slash_string)
        .unwrap_or_else(|_| path_to_forward_slash_string(path))
}

fn current_timestamp() -> Result<String, String> {
    OffsetDateTime::now_utc()
        .format(&Rfc3339)
        .map_err(|err| err.to_string())
}

fn roi_axis_values(count: u32) -> Vec<u32> {
    (0..count).collect()
}

fn read_roi_index(workspace_path: &str, pos: u32) -> Result<RoiIndexFile, String> {
    let path = workspace_roi_index_path(workspace_path, pos);
    let bytes = fs::read(&path).map_err(|err| err.to_string())?;
    let index =
        serde_json::from_slice::<RoiIndexFile>(&bytes).map_err(|err| format!("{}: {err}", path.display()))?;

    if index.position != pos {
        return Err(format!(
            "ROI index position {} does not match Pos{}",
            index.position, pos
        ));
    }
    if index.axis_order != "TCZYX" {
        return Err(format!(
            "Unsupported ROI axis order '{}' for Pos{}",
            index.axis_order, pos
        ));
    }
    let has_supported_page_order = index.page_order.len() == 3
        && index.page_order[0] == "t"
        && index.page_order[1] == "c"
        && index.page_order[2] == "z";
    if !has_supported_page_order {
        return Err(format!(
            "Unsupported ROI page order {:?} for Pos{}",
            index.page_order, pos
        ));
    }

    for roi in &index.rois {
        if roi.shape[0] != index.time_count
            || roi.shape[1] != index.channel_count
            || roi.shape[2] != index.z_count
            || roi.shape[3] != roi.bbox.h
            || roi.shape[4] != roi.bbox.w
        {
            return Err(format!("ROI {} shape metadata does not match index", roi.roi));
        }
    }

    Ok(index)
}

fn read_annotation_labels(workspace_path: &str) -> Result<Vec<AnnotationLabel>, String> {
    let path = workspace_annotation_labels_path(workspace_path);
    let bytes =
        fs::read(&path).map_err(|err| format!("Failed to read annotation labels at {}: {err}", path.display()))?;
    let parsed = serde_json::from_slice::<AnnotationLabelsFile>(&bytes)
        .map_err(|err| format!("{}: {err}", path.display()))?;
    let labels = match parsed {
        AnnotationLabelsFile::Wrapped { labels } => labels,
        AnnotationLabelsFile::Array(labels) => labels,
    };

    let mut ids = BTreeSet::new();
    for label in &labels {
        if label.id.trim().is_empty() {
            return Err(format!("Annotation labels at {} contain an empty id", path.display()));
        }
        if label.name.trim().is_empty() {
            return Err(format!(
                "Annotation labels at {} contain an empty name for id '{}'",
                path.display(),
                label.id
            ));
        }
        if label.color.trim().is_empty() {
            return Err(format!(
                "Annotation labels at {} contain an empty color for id '{}'",
                path.display(),
                label.id
            ));
        }
        if !ids.insert(label.id.clone()) {
            return Err(format!(
                "Annotation labels at {} contain duplicate id '{}'",
                path.display(),
                label.id
            ));
        }
    }

    Ok(labels)
}

fn decode_png_mask(bytes: &[u8]) -> Result<(u32, u32, Vec<u8>), String> {
    let decoder = PngDecoder::new(Cursor::new(bytes));
    let mut reader = decoder.read_info().map_err(|err| err.to_string())?;
    let mut buffer = vec![0; reader.output_buffer_size()];
    let info = reader.next_frame(&mut buffer).map_err(|err| err.to_string())?;
    if info.bit_depth != BitDepth::Eight {
        return Err(format!(
            "Unsupported annotation mask bit depth {:?}; expected 8-bit PNG",
            info.bit_depth
        ));
    }

    let data = &buffer[..info.buffer_size()];
    let mut mask = Vec::with_capacity((info.width * info.height) as usize);
    match info.color_type {
        ColorType::Grayscale => mask.extend_from_slice(data),
        ColorType::GrayscaleAlpha => {
            for chunk in data.chunks_exact(2) {
                mask.push(chunk[0]);
            }
        }
        ColorType::Rgb => {
            for chunk in data.chunks_exact(3) {
                mask.push(chunk[0]);
            }
        }
        ColorType::Rgba => {
            for chunk in data.chunks_exact(4) {
                mask.push(chunk[0]);
            }
        }
        ColorType::Indexed => {
            return Err("Indexed PNG masks are not supported".to_string());
        }
    }

    Ok((info.width, info.height, mask))
}

fn validate_mask_pixels(mask: &[u8], width: u32, height: u32, label_count: usize) -> Result<(), String> {
    let expected = (width as usize).saturating_mul(height as usize);
    if mask.len() != expected {
        return Err(format!(
            "Annotation mask pixel count {} does not match expected frame size {}",
            mask.len(), expected
        ));
    }

    let max_allowed = label_count.min(u8::MAX as usize) as u8;
    if let Some(value) = mask.iter().copied().find(|value| *value > max_allowed) {
        return Err(format!(
            "Annotation mask contains class index {} beyond configured label range {}",
            value, max_allowed
        ));
    }

    Ok(())
}

fn empty_annotation() -> RoiFrameAnnotation {
    RoiFrameAnnotation {
        classification_label_id: None,
        mask_path: None,
        updated_at: None,
    }
}

fn load_annotation_labels(workspace_path: String) -> Result<Vec<AnnotationLabel>, String> {
    read_annotation_labels(&workspace_path)
}

fn load_roi_frame_annotation(
    workspace_path: String,
    request: RoiFrameRequest,
) -> Result<LoadedRoiFrameAnnotation, String> {
    let index = read_roi_index(&workspace_path, request.pos)?;
    let roi = index
        .rois
        .iter()
        .find(|entry| entry.roi == request.roi)
        .ok_or_else(|| format!("ROI {} not found for Pos{}", request.roi, request.pos))?;
    let annotation_path = workspace_annotation_json_path(&workspace_path, &request);
    if !annotation_path.is_file() {
        return Ok(LoadedRoiFrameAnnotation {
            annotation: empty_annotation(),
            mask_base64_png: None,
        });
    }

    let bytes = fs::read(&annotation_path).map_err(|err| err.to_string())?;
    let annotation = serde_json::from_slice::<RoiFrameAnnotationFile>(&bytes)
        .map_err(|err| format!("{}: {err}", annotation_path.display()))?;

    let (mask_path, mask_base64_png) = if let Some(mask_file_name) = annotation.mask_file_name.clone() {
        let path = workspace_annotation_roi_dir_path(&workspace_path, &request).join(mask_file_name);
        let mask_bytes = fs::read(&path).map_err(|err| err.to_string())?;
        let (mask_width, mask_height, _) = decode_png_mask(&mask_bytes)?;
        if mask_width != roi.bbox.w || mask_height != roi.bbox.h {
            return Err(format!(
                "Annotation mask {} dimensions {}x{} do not match ROI {} frame {}x{}",
                path.display(),
                mask_width,
                mask_height,
                roi.roi,
                roi.bbox.w,
                roi.bbox.h
            ));
        }
        (
            Some(workspace_relative_path(&workspace_path, &path)),
            Some(BASE64_STANDARD.encode(mask_bytes)),
        )
    } else {
        (None, None)
    };

    Ok(LoadedRoiFrameAnnotation {
        annotation: RoiFrameAnnotation {
            classification_label_id: annotation.classification_label_id,
            mask_path,
            updated_at: Some(annotation.updated_at),
        },
        mask_base64_png,
    })
}

fn save_roi_frame_annotation(
    workspace_path: String,
    request: RoiFrameRequest,
    annotation: RoiFrameAnnotationPayload,
) -> Result<RoiFrameAnnotation, String> {
    let index = read_roi_index(&workspace_path, request.pos)?;
    let roi = index
        .rois
        .iter()
        .find(|entry| entry.roi == request.roi)
        .ok_or_else(|| format!("ROI {} not found for Pos{}", request.roi, request.pos))?;
    let labels = read_annotation_labels(&workspace_path)?;
    let label_count = labels.len();

    if let Some(label_id) = annotation.classification_label_id.as_ref() {
        if !labels.iter().any(|label| label.id == *label_id) {
            return Err(format!("Unknown annotation label id '{}'", label_id));
        }
    }

    let annotation_dir = workspace_annotation_roi_dir_path(&workspace_path, &request);
    let annotation_path = workspace_annotation_json_path(&workspace_path, &request);
    let mask_path = workspace_annotation_mask_path(&workspace_path, &request);

    if annotation.classification_label_id.is_none() && annotation.mask_base64_png.is_none() {
        if annotation_path.exists() {
            fs::remove_file(&annotation_path).map_err(|err| err.to_string())?;
        }
        if mask_path.exists() {
            fs::remove_file(&mask_path).map_err(|err| err.to_string())?;
        }
        return Ok(empty_annotation());
    }

    fs::create_dir_all(&annotation_dir).map_err(|err| err.to_string())?;

    let mask_file_name = if let Some(mask_base64_png) = annotation.mask_base64_png.as_ref() {
        let mask_bytes = BASE64_STANDARD
            .decode(mask_base64_png)
            .map_err(|err| format!("Invalid annotation PNG payload: {err}"))?;
        let (mask_width, mask_height, mask_pixels) = decode_png_mask(&mask_bytes)?;
        if mask_width != roi.bbox.w || mask_height != roi.bbox.h {
            return Err(format!(
                "Annotation mask dimensions {}x{} do not match ROI {} frame {}x{}",
                mask_width, mask_height, roi.roi, roi.bbox.w, roi.bbox.h
            ));
        }
        validate_mask_pixels(&mask_pixels, mask_width, mask_height, label_count)?;
        fs::write(&mask_path, mask_bytes).map_err(|err| err.to_string())?;
        Some(
            mask_path
                .file_name()
                .ok_or_else(|| "Failed to resolve annotation mask file name".to_string())?
                .to_string_lossy()
                .to_string(),
        )
    } else {
        if mask_path.exists() {
            fs::remove_file(&mask_path).map_err(|err| err.to_string())?;
        }
        None
    };

    let updated_at = current_timestamp()?;
    let annotation_file = RoiFrameAnnotationFile {
        schema_version: annotation_schema_version(),
        classification_label_id: annotation.classification_label_id.clone(),
        mask_file_name: mask_file_name.clone(),
        updated_at: updated_at.clone(),
    };
    let bytes = serde_json::to_vec_pretty(&annotation_file).map_err(|err| err.to_string())?;
    fs::write(&annotation_path, bytes).map_err(|err| err.to_string())?;

    Ok(RoiFrameAnnotation {
        classification_label_id: annotation.classification_label_id,
        mask_path: mask_file_name.map(|_| workspace_relative_path(&workspace_path, &mask_path)),
        updated_at: Some(updated_at),
    })
}

fn parse_bbox_csv(path: &Path) -> Result<Vec<RoiBbox>, String> {
    let csv = fs::read_to_string(path).map_err(|err| err.to_string())?;
    let mut lines = csv.lines().filter(|line| !line.trim().is_empty());
    let header = lines
        .next()
        .ok_or_else(|| "BBox CSV is empty".to_string())?
        .split(',')
        .map(|value| value.trim().to_ascii_lowercase())
        .collect::<Vec<_>>();

    let roi_idx = header
        .iter()
        .position(|value| value == "roi" || value == "crop")
        .ok_or_else(|| "BBox CSV is missing roi/crop column".to_string())?;
    let x_idx = header
        .iter()
        .position(|value| value == "x")
        .ok_or_else(|| "BBox CSV is missing x column".to_string())?;
    let y_idx = header
        .iter()
        .position(|value| value == "y")
        .ok_or_else(|| "BBox CSV is missing y column".to_string())?;
    let w_idx = header
        .iter()
        .position(|value| value == "w")
        .ok_or_else(|| "BBox CSV is missing w column".to_string())?;
    let h_idx = header
        .iter()
        .position(|value| value == "h")
        .ok_or_else(|| "BBox CSV is missing h column".to_string())?;
    let required_idx = *[roi_idx, x_idx, y_idx, w_idx, h_idx]
        .iter()
        .max()
        .expect("bbox indices should exist");

    let mut bboxes = Vec::new();
    let mut seen_rois = BTreeSet::new();
    for (line_number, line) in lines.enumerate() {
        let parts = line.split(',').map(|value| value.trim()).collect::<Vec<_>>();
        if parts.len() <= required_idx {
            return Err(format!("BBox CSV row {} is malformed", line_number + 2));
        }

        let bbox = RoiBbox {
            roi: parts[roi_idx]
                .parse()
                .map_err(|_| format!("Invalid roi value on row {}", line_number + 2))?,
            x: parts[x_idx]
                .parse()
                .map_err(|_| format!("Invalid x value on row {}", line_number + 2))?,
            y: parts[y_idx]
                .parse()
                .map_err(|_| format!("Invalid y value on row {}", line_number + 2))?,
            w: parts[w_idx]
                .parse()
                .map_err(|_| format!("Invalid w value on row {}", line_number + 2))?,
            h: parts[h_idx]
                .parse()
                .map_err(|_| format!("Invalid h value on row {}", line_number + 2))?,
        };

        if bbox.w == 0 || bbox.h == 0 {
            return Err(format!("BBox row {} must have positive width and height", line_number + 2));
        }
        if !seen_rois.insert(bbox.roi) {
            return Err(format!("Duplicate roi {} in bbox CSV", bbox.roi));
        }

        bboxes.push(bbox);
    }

    if bboxes.is_empty() {
        return Err("BBox CSV does not contain any ROI rows".to_string());
    }

    bboxes.sort_by_key(|bbox| bbox.roi);
    Ok(bboxes)
}

fn validate_bboxes(bboxes: &[RoiBbox], width: u32, height: u32) -> Result<(), String> {
    for bbox in bboxes {
        let max_x = bbox
            .x
            .checked_add(bbox.w)
            .ok_or_else(|| format!("ROI {} overflows x bounds", bbox.roi))?;
        let max_y = bbox
            .y
            .checked_add(bbox.h)
            .ok_or_else(|| format!("ROI {} overflows y bounds", bbox.roi))?;
        if max_x > width || max_y > height {
            return Err(format!(
                "ROI {} bbox ({}, {}, {}, {}) exceeds frame bounds {}x{}",
                bbox.roi, bbox.x, bbox.y, bbox.w, bbox.h, width, height
            ));
        }
    }
    Ok(())
}

fn crop_u16_frame(frame: &[u16], frame_width: u32, bbox: &RoiBbox) -> Vec<u16> {
    let mut cropped = vec![0u16; (bbox.w * bbox.h) as usize];
    for row in 0..bbox.h {
        let src_start = ((bbox.y + row) * frame_width + bbox.x) as usize;
        let dst_start = (row * bbox.w) as usize;
        cropped[dst_start..dst_start + bbox.w as usize]
            .copy_from_slice(&frame[src_start..src_start + bbox.w as usize]);
    }
    cropped
}

fn write_roi_index(
    workspace_path: &str,
    pos: u32,
    source: ViewerSource,
    times: &[u32],
    channels: &[u32],
    z_slices: &[u32],
    bboxes: &[RoiBbox],
) -> Result<PathBuf, String> {
    let rois = bboxes
        .iter()
        .map(|bbox| RoiIndexEntry {
            roi: bbox.roi,
            file_name: format!("Roi{}.tif", bbox.roi),
            bbox: bbox.clone(),
            shape: [
                times.len() as u32,
                channels.len() as u32,
                z_slices.len() as u32,
                bbox.h,
                bbox.w,
            ],
        })
        .collect::<Vec<_>>();

    let index = RoiIndexFile {
        position: pos,
        axis_order: "TCZYX".to_string(),
        page_order: vec!["t".to_string(), "c".to_string(), "z".to_string()],
        time_count: times.len() as u32,
        channel_count: channels.len() as u32,
        z_count: z_slices.len() as u32,
        source,
        rois,
    };

    let path = workspace_roi_index_path(workspace_path, pos);
    let bytes = serde_json::to_vec_pretty(&index).map_err(|err| err.to_string())?;
    fs::write(&path, bytes).map_err(|err| err.to_string())?;
    Ok(path)
}

fn prepare_roi_output_dir(workspace_path: &str, pos: u32) -> Result<PathBuf, String> {
    let pos_dir = workspace_roi_pos_dir_path(workspace_path, pos);
    if pos_dir.exists() {
        fs::remove_dir_all(&pos_dir).map_err(|err| err.to_string())?;
    }
    fs::create_dir_all(&pos_dir).map_err(|err| err.to_string())?;
    Ok(pos_dir)
}

fn crop_tif_source<F>(
    workspace_path: &str,
    root: &Path,
    pos: u32,
    bboxes: &[RoiBbox],
    progress: &mut F,
) -> Result<PathBuf, String>
where
    F: FnMut(f64, &str) -> Result<(), String>,
{
    let pos_dir = find_position_dir(root, pos)?;
    let mut index = HashMap::<(u32, u32, u32), PathBuf>::new();
    let mut channels = BTreeSet::new();
    let mut times = BTreeSet::new();
    let mut z_slices = BTreeSet::new();

    for (path, parsed) in collect_tiffs(&pos_dir) {
        if parsed.position != pos {
            continue;
        }
        channels.insert(parsed.channel);
        times.insert(parsed.time);
        z_slices.insert(parsed.z);
        index.insert((parsed.channel, parsed.time, parsed.z), path);
    }

    let channels = channels.into_iter().collect::<Vec<_>>();
    let times = times.into_iter().collect::<Vec<_>>();
    let z_slices = z_slices.into_iter().collect::<Vec<_>>();
    if channels.is_empty() || times.is_empty() || z_slices.is_empty() {
        return Err(format!("No TIFF frames found for Pos{pos}"));
    }

    let first_path = index
        .get(&(channels[0], times[0], z_slices[0]))
        .ok_or_else(|| format!("Missing TIFF frame for Pos{pos}"))?;
    let first_frame = load_tiff_frame(first_path)?;
    validate_bboxes(bboxes, first_frame.width, first_frame.height)?;

    prepare_roi_output_dir(workspace_path, pos)?;
    progress(0.02, &format!("Opening ROI TIFF writers for Pos{pos}"))?;
    let mut encoders = bboxes
        .iter()
        .map(|bbox| {
            let path = workspace_roi_tiff_path(workspace_path, pos, bbox.roi);
            let file = File::create(path).map_err(|err| err.to_string())?;
            Ok(TiffEncoder::new(BufWriter::new(file)).map_err(|err| err.to_string())?)
        })
        .collect::<Result<Vec<_>, String>>()?;

    let total_planes = times.len() * channels.len() * z_slices.len();
    let mut processed_planes = 0usize;
    for time in &times {
        for channel in &channels {
            for z in &z_slices {
                let path = index.get(&(*channel, *time, *z)).ok_or_else(|| {
                    format!("Missing TIFF frame for Pos{pos}, channel {channel}, time {time}, z {z}")
                })?;
                let frame = load_tiff_frame(path)?;
                if frame.width != first_frame.width || frame.height != first_frame.height {
                    return Err("Inconsistent TIFF dimensions across stack".to_string());
                }

                for (encoder, bbox) in encoders.iter_mut().zip(bboxes.iter()) {
                    let cropped = crop_u16_frame(&frame.data, frame.width, bbox);
                    encoder
                        .write_image::<colortype::Gray16>(bbox.w, bbox.h, &cropped)
                        .map_err(|err| err.to_string())?;
                }
                processed_planes += 1;
                let plane_progress = if total_planes == 0 {
                    1.0
                } else {
                    processed_planes as f64 / total_planes as f64
                };
                progress(
                    0.02 + plane_progress * 0.96,
                    &format!("Cropping frame {processed_planes}/{total_planes} for Pos{pos}"),
                )?;
            }
        }
    }

    progress(0.99, &format!("Writing ROI index for Pos{pos}"))?;
    write_roi_index(
        workspace_path,
        pos,
        ViewerSource::Tif {
            path: root.to_string_lossy().to_string(),
        },
        &times,
        &channels,
        &z_slices,
        bboxes,
    )?;
    progress(1.0, &format!("Finished ROI crop for Pos{pos}"))?;
    Ok(workspace_roi_pos_dir_path(workspace_path, pos))
}

fn crop_nd2_source<F>(
    workspace_path: &str,
    path: &Path,
    pos: u32,
    bboxes: &[RoiBbox],
    progress: &mut F,
) -> Result<PathBuf, String>
where
    F: FnMut(f64, &str) -> Result<(), String>,
{
    let mut nd2 = Nd2File::open(path).map_err(|err| err.to_string())?;
    let sizes = nd2.sizes().map_err(|err| err.to_string())?;
    let width = u32::try_from(dimension_size(&sizes, "X")).map_err(|err| err.to_string())?;
    let height = u32::try_from(dimension_size(&sizes, "Y")).map_err(|err| err.to_string())?;
    let positions = dimension_values(&sizes, "P");
    let channels = dimension_values(&sizes, "C");
    let times = dimension_values(&sizes, "T");
    let z_slices = dimension_values(&sizes, "Z");
    if !positions.contains(&pos) {
        return Err(format!("Position index {pos} is out of range"));
    }

    let pos_index = validate_request_index("Position", pos, dimension_size(&sizes, "P"))?;
    validate_bboxes(bboxes, width, height)?;

    prepare_roi_output_dir(workspace_path, pos)?;
    progress(0.02, &format!("Opening ROI TIFF writers for Pos{pos}"))?;
    let mut encoders = bboxes
        .iter()
        .map(|bbox| {
            let path = workspace_roi_tiff_path(workspace_path, pos, bbox.roi);
            let file = File::create(path).map_err(|err| err.to_string())?;
            Ok(TiffEncoder::new(BufWriter::new(file)).map_err(|err| err.to_string())?)
        })
        .collect::<Result<Vec<_>, String>>()?;

    let total_planes = times.len() * channels.len() * z_slices.len();
    let mut processed_planes = 0usize;
    for time in &times {
        let time_index = validate_request_index("Time", *time, dimension_size(&sizes, "T"))?;
        for channel in &channels {
            let channel_index =
                validate_request_index("Channel", *channel, dimension_size(&sizes, "C"))?;
            for z in &z_slices {
                let z_index = validate_request_index("Z", *z, dimension_size(&sizes, "Z"))?;
                let frame = nd2
                    .read_frame_2d(pos_index, time_index, channel_index, z_index)
                    .map_err(|err| err.to_string())?;
                if frame.len() != width as usize * height as usize {
                    return Err("Unexpected ND2 frame dimensions".to_string());
                }

                for (encoder, bbox) in encoders.iter_mut().zip(bboxes.iter()) {
                    let cropped = crop_u16_frame(&frame, width, bbox);
                    encoder
                        .write_image::<colortype::Gray16>(bbox.w, bbox.h, &cropped)
                        .map_err(|err| err.to_string())?;
                }
                processed_planes += 1;
                let plane_progress = if total_planes == 0 {
                    1.0
                } else {
                    processed_planes as f64 / total_planes as f64
                };
                progress(
                    0.02 + plane_progress * 0.96,
                    &format!("Cropping frame {processed_planes}/{total_planes} for Pos{pos}"),
                )?;
            }
        }
    }

    progress(0.99, &format!("Writing ROI index for Pos{pos}"))?;
    write_roi_index(
        workspace_path,
        pos,
        ViewerSource::Nd2 {
            path: path.to_string_lossy().to_string(),
        },
        &times,
        &channels,
        &z_slices,
        bboxes,
    )?;
    progress(1.0, &format!("Finished ROI crop for Pos{pos}"))?;
    Ok(workspace_roi_pos_dir_path(workspace_path, pos))
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

fn scan_roi_workspace(workspace_path: String) -> Result<RoiWorkspaceScan, String> {
    let root = Path::new(&workspace_path).join("roi");
    if !root.is_dir() {
        return Ok(RoiWorkspaceScan {
            positions: Vec::new(),
        });
    }

    let mut positions = Vec::<RoiPositionScan>::new();
    let entries = fs::read_dir(&root).map_err(|err| err.to_string())?;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }

        let Some(name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        let Some(pos) = parse_pos_dir_name(&name) else {
            continue;
        };

        let index = read_roi_index(&workspace_path, pos)?;
        positions.push(RoiPositionScan {
            pos,
            source: index.source.clone(),
            channels: roi_axis_values(index.channel_count),
            times: roi_axis_values(index.time_count),
            z_slices: roi_axis_values(index.z_count),
            rois: index.rois.clone(),
        });
    }

    positions.sort_by_key(|entry| entry.pos);
    Ok(RoiWorkspaceScan { positions })
}

fn load_roi_frame(workspace_path: String, request: RoiFrameRequest) -> Result<RawFrame, String> {
    let index = read_roi_index(&workspace_path, request.pos)?;
    let roi = index
        .rois
        .iter()
        .find(|entry| entry.roi == request.roi)
        .ok_or_else(|| format!("ROI {} not found for Pos{}", request.roi, request.pos))?;

    if request.time >= index.time_count {
        return Err(format!("Time index {} is out of range", request.time));
    }
    if request.channel >= index.channel_count {
        return Err(format!("Channel index {} is out of range", request.channel));
    }
    if request.z >= index.z_count {
        return Err(format!("Z index {} is out of range", request.z));
    }

    let page = ((request.time * index.channel_count + request.channel) * index.z_count + request.z)
        as usize;
    let raw = load_tiff_frame_page(
        &workspace_roi_tiff_path(&workspace_path, request.pos, request.roi),
        page,
    )?;
    if raw.width != roi.bbox.w || raw.height != roi.bbox.h {
        return Err(format!(
            "ROI {} TIFF page dimensions {}x{} do not match index {}x{}",
            request.roi, raw.width, raw.height, roi.bbox.w, roi.bbox.h
        ));
    }

    Ok(raw)
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

fn crop_roi<F>(
    workspace_path: String,
    source: ViewerSource,
    pos: u32,
    format: CropOutputFormat,
    progress: &mut F,
) -> CropRoiResponse
where
    F: FnMut(f64, &str) -> Result<(), String>,
{
    if !matches!(format, CropOutputFormat::Tiff) {
        return CropRoiResponse {
            ok: false,
            error: Some("Unsupported crop output format".to_string()),
            output_path: None,
        };
    }

    let bbox_path = workspace_bbox_csv_path(&workspace_path, pos);
    if !bbox_path.is_file() {
        return CropRoiResponse {
            ok: false,
            error: Some(format!("BBox CSV not found at {}", bbox_path.display())),
            output_path: None,
        };
    }

    if let Err(error) = progress(0.0, &format!("Reading bbox CSV for Pos{pos}")) {
        return CropRoiResponse {
            ok: false,
            error: Some(error),
            output_path: None,
        };
    }
    let result = parse_bbox_csv(&bbox_path).and_then(|bboxes| match &source {
        ViewerSource::Tif { path } => {
            progress(0.01, &format!("Scanning TIFF stack for Pos{pos}"))?;
            crop_tif_source(&workspace_path, Path::new(path), pos, &bboxes, progress)
        }
        ViewerSource::Nd2 { path } => {
            progress(0.01, &format!("Opening ND2 source for Pos{pos}"))?;
            crop_nd2_source(&workspace_path, Path::new(path), pos, &bboxes, progress)
        }
    });

    match result {
        Ok(output_path) => CropRoiResponse {
            ok: true,
            error: None,
            output_path: Some(output_path.to_string_lossy().to_string()),
        },
        Err(error) => CropRoiResponse {
            ok: false,
            error: Some(error),
            output_path: None,
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

fn crop_progress_response(id: String, progress: f64, message: String) -> String {
    ok_response(
        id,
        "crop_roi_progress",
        CropRoiProgressPayload {
            progress: progress.clamp(0.0, 1.0),
            message,
        },
    )
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

pub fn handle_ws_request_with_progress<F>(text: &str, mut emit_progress: F) -> Option<String>
where
    F: FnMut(String) -> Result<(), String>,
{
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
        "scan_roi_workspace" => {
            let payload = serde_json::from_value::<ScanRoiWorkspacePayload>(envelope.payload)
                .map_err(|err| err.to_string());
            match catch_backend_panic(|| {
                payload.and_then(|payload| scan_roi_workspace(payload.workspace_path))
            }) {
                Ok(scan) => ok_response(id, "scan_roi_workspace_result", scan),
                Err(message) => error_response(id, message),
            }
        }
        "load_annotation_labels" => {
            let payload = serde_json::from_value::<LoadAnnotationLabelsPayload>(envelope.payload)
                .map_err(|err| err.to_string());
            match catch_backend_panic(|| {
                payload.and_then(|payload| load_annotation_labels(payload.workspace_path))
            }) {
                Ok(labels) => ok_response(id, "load_annotation_labels_result", labels),
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
        "load_roi_frame" => {
            let payload = serde_json::from_value::<LoadRoiFramePayload>(envelope.payload)
                .map_err(|err| err.to_string());
            match catch_backend_panic(|| {
                payload.and_then(|payload| {
                    let raw = load_roi_frame(payload.workspace_path, payload.request)?;
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
                Ok(frame) => ok_response(id, "load_roi_frame_result", frame),
                Err(message) => error_response(id, message),
            }
        }
        "load_roi_frame_annotation" => {
            let payload = serde_json::from_value::<LoadRoiFrameAnnotationPayload>(envelope.payload)
                .map_err(|err| err.to_string());
            match catch_backend_panic(|| {
                payload.and_then(|payload| {
                    load_roi_frame_annotation(payload.workspace_path, payload.request)
                })
            }) {
                Ok(annotation) => ok_response(id, "load_roi_frame_annotation_result", annotation),
                Err(message) => error_response(id, message),
            }
        }
        "save_roi_frame_annotation" => {
            let payload = serde_json::from_value::<SaveRoiFrameAnnotationPayload>(envelope.payload)
                .map_err(|err| err.to_string());
            match catch_backend_panic(|| {
                payload.and_then(|payload| {
                    save_roi_frame_annotation(
                        payload.workspace_path,
                        payload.request,
                        payload.annotation,
                    )
                })
            }) {
                Ok(annotation) => ok_response(id, "save_roi_frame_annotation_result", annotation),
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
        "crop_roi" => {
            let payload = serde_json::from_value::<CropRoiPayload>(envelope.payload)
                .map_err(|err| err.to_string());
            match payload {
                Ok(payload) => {
                    let progress_id = id.clone();
                    let response_id = id.clone();
                    let mut progress = |value: f64, message: &str| {
                        emit_progress(crop_progress_response(
                            progress_id.clone(),
                            value,
                            message.to_string(),
                        ))
                    };
                    ok_response(
                        response_id,
                        "crop_roi_result",
                        crop_roi(
                            payload.workspace_path,
                            payload.source,
                            payload.pos,
                            payload.format,
                            &mut progress,
                        ),
                    )
                }
                Err(message) => error_response(id, message),
            }
        }
        _ => error_response(id, "Unsupported request type".to_string()),
    };

    Some(response)
}

pub fn handle_ws_request(text: &str) -> Option<String> {
    handle_ws_request_with_progress(text, |_| Ok(()))
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::io::{BufReader, BufWriter};
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    use base64::prelude::{Engine as _, BASE64_STANDARD};
    use png::{BitDepth, ColorType, Encoder as PngEncoder};
    use tiff::decoder::{Decoder, DecodingResult};
    use tiff::encoder::{colortype, TiffEncoder};

    use super::{
        auto_contrast, catch_backend_panic, crop_roi, load_annotation_labels,
        load_roi_frame, load_roi_frame_annotation, parse_bbox_csv, parse_pos_dir_name,
        parse_tiff_name, read_roi_index, save_bbox, save_roi_frame_annotation,
        scan_roi_workspace, workspace_annotation_json_path, workspace_annotation_labels_path,
        workspace_annotation_mask_path, workspace_bbox_csv_path, workspace_roi_index_path,
        workspace_roi_tiff_path, ContrastWindow, CropOutputFormat, RoiFrameAnnotationPayload,
        RoiFrameRequest, RoiIndexFile, ViewerSource,
    };

    fn unique_temp_dir(prefix: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("{prefix}-{unique}"))
    }

    fn write_test_u16_tiff(path: &PathBuf, width: u32, height: u32, data: &[u16]) {
        let file = fs::File::create(path).unwrap();
        let mut encoder = TiffEncoder::new(BufWriter::new(file)).unwrap();
        encoder
            .write_image::<colortype::Gray16>(width, height, data)
            .unwrap();
    }

    fn write_test_u16_tiff_pages(path: &PathBuf, width: u32, height: u32, pages: &[Vec<u16>]) {
        let file = fs::File::create(path).unwrap();
        let mut encoder = TiffEncoder::new(BufWriter::new(file)).unwrap();
        for page in pages {
            encoder
                .write_image::<colortype::Gray16>(width, height, page)
                .unwrap();
        }
    }

    fn write_test_png_mask(path: &PathBuf, width: u32, height: u32, data: &[u8]) {
        let file = fs::File::create(path).unwrap();
        let writer = BufWriter::new(file);
        let mut encoder = PngEncoder::new(writer, width, height);
        encoder.set_color(ColorType::Grayscale);
        encoder.set_depth(BitDepth::Eight);
        let mut writer = encoder.write_header().unwrap();
        writer.write_image_data(data).unwrap();
    }

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
        let root = unique_temp_dir("view-tauri-save-bbox");
        let source = ViewerSource::Tif {
            path: root.join("images").to_string_lossy().to_string(),
        };

        let result = save_bbox(
            root.to_string_lossy().to_string(),
            source.clone(),
            7,
            "roi,x,y,w,h\n0,1,2,3,4".to_string(),
        );
        assert!(result.ok);

        let saved_path = workspace_bbox_csv_path(&root.to_string_lossy(), 7);
        let saved = fs::read_to_string(&saved_path).unwrap();
        assert_eq!(saved, "roi,x,y,w,h\n0,1,2,3,4\n");

        let _ = fs::remove_file(saved_path);
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn parses_bbox_csv_with_roi_or_crop_columns() {
        let root = unique_temp_dir("view-parse-bbox");
        fs::create_dir_all(&root).unwrap();
        let path = root.join("bbox.csv");
        fs::write(&path, "crop,x,y,w,h\n3,10,11,12,13\n").unwrap();

        let parsed = parse_bbox_csv(&path).unwrap();
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].roi, 3);
        assert_eq!(parsed[0].x, 10);
        assert_eq!(parsed[0].y, 11);
        assert_eq!(parsed[0].w, 12);
        assert_eq!(parsed[0].h, 13);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn reads_roi_index_json() {
        let root = unique_temp_dir("view-read-roi-index");
        let roi_dir = root.join("roi").join("Pos5");
        fs::create_dir_all(&roi_dir).unwrap();
        let index = serde_json::json!({
            "position": 5,
            "axisOrder": "TCZYX",
            "pageOrder": ["t", "c", "z"],
            "timeCount": 2,
            "channelCount": 3,
            "zCount": 1,
            "source": { "kind": "nd2", "path": "/tmp/source.nd2" },
            "rois": [{
                "roi": 4,
                "fileName": "Roi4.tif",
                "bbox": { "roi": 4, "x": 10, "y": 11, "w": 12, "h": 13 },
                "shape": [2, 3, 1, 13, 12]
            }]
        });
        fs::write(roi_dir.join("index.json"), serde_json::to_vec_pretty(&index).unwrap()).unwrap();

        let parsed = read_roi_index(&root.to_string_lossy(), 5).unwrap();
        assert_eq!(parsed.position, 5);
        assert_eq!(parsed.time_count, 2);
        assert_eq!(parsed.channel_count, 3);
        assert_eq!(parsed.rois[0].roi, 4);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn scans_roi_workspace_positions() {
        let root = unique_temp_dir("view-scan-roi-workspace");
        let roi_dir = root.join("roi").join("Pos2");
        fs::create_dir_all(&roi_dir).unwrap();
        let index = RoiIndexFile {
            position: 2,
            axis_order: "TCZYX".to_string(),
            page_order: vec!["t".to_string(), "c".to_string(), "z".to_string()],
            time_count: 4,
            channel_count: 2,
            z_count: 1,
            source: ViewerSource::Tif {
                path: "/tmp/images".to_string(),
            },
            rois: vec![super::RoiIndexEntry {
                roi: 1,
                file_name: "Roi1.tif".to_string(),
                bbox: super::RoiBbox {
                    roi: 1,
                    x: 1,
                    y: 2,
                    w: 3,
                    h: 4,
                },
                shape: [4, 2, 1, 4, 3],
            }],
        };
        fs::write(
            roi_dir.join("index.json"),
            serde_json::to_vec_pretty(&index).unwrap(),
        )
        .unwrap();

        let scan = scan_roi_workspace(root.to_string_lossy().to_string()).unwrap();
        assert_eq!(scan.positions.len(), 1);
        assert_eq!(scan.positions[0].pos, 2);
        assert_eq!(scan.positions[0].times, vec![0, 1, 2, 3]);
        assert_eq!(scan.positions[0].channels, vec![0, 1]);
        assert_eq!(scan.positions[0].z_slices, vec![0]);
        assert_eq!(scan.positions[0].rois[0].roi, 1);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn loads_annotation_labels_from_wrapped_json() {
        let root = unique_temp_dir("view-annotation-labels");
        let annotations_dir = root.join("annotations");
        fs::create_dir_all(&annotations_dir).unwrap();
        fs::write(
            workspace_annotation_labels_path(&root.to_string_lossy()),
            serde_json::json!({
                "labels": [
                    { "id": "cell", "name": "Cell", "color": "#22c55e" },
                    { "id": "debris", "name": "Debris", "color": "#f97316" }
                ]
            })
            .to_string(),
        )
        .unwrap();

        let labels = load_annotation_labels(root.to_string_lossy().to_string()).unwrap();
        assert_eq!(labels.len(), 2);
        assert_eq!(labels[0].id, "cell");
        assert_eq!(labels[1].color, "#f97316");

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn crop_roi_writes_tiff_stacks_and_index_for_tif_source() {
        let root = unique_temp_dir("view-crop-roi");
        let workspace = root.join("workspace");
        let source_root = root.join("images");
        let pos_dir = source_root.join("Pos7");
        fs::create_dir_all(&workspace).unwrap();
        fs::create_dir_all(&pos_dir).unwrap();

        let frames = [
            (
                "img_channel000_position007_time000000000_z000.tif",
                vec![
                    1u16, 2, 3, 4, //
                    5, 6, 7, 8, //
                    9, 10, 11, 12, //
                    13, 14, 15, 16,
                ],
            ),
            (
                "img_channel001_position007_time000000000_z000.tif",
                vec![
                    101u16, 102, 103, 104, //
                    105, 106, 107, 108, //
                    109, 110, 111, 112, //
                    113, 114, 115, 116,
                ],
            ),
            (
                "img_channel000_position007_time000000001_z000.tif",
                vec![
                    201u16, 202, 203, 204, //
                    205, 206, 207, 208, //
                    209, 210, 211, 212, //
                    213, 214, 215, 216,
                ],
            ),
            (
                "img_channel001_position007_time000000001_z000.tif",
                vec![
                    301u16, 302, 303, 304, //
                    305, 306, 307, 308, //
                    309, 310, 311, 312, //
                    313, 314, 315, 316,
                ],
            ),
        ];
        for (name, data) in frames {
            write_test_u16_tiff(&pos_dir.join(name), 4, 4, &data);
        }

        let bbox_dir = workspace.join("bbox");
        fs::create_dir_all(&bbox_dir).unwrap();
        fs::write(
            bbox_dir.join("Pos7.csv"),
            "roi,x,y,w,h\n0,1,1,2,2\n1,0,0,1,1\n",
        )
        .unwrap();

        let mut progress_events = Vec::new();
        let response = crop_roi(
            workspace.to_string_lossy().to_string(),
            ViewerSource::Tif {
                path: source_root.to_string_lossy().to_string(),
            },
            7,
            CropOutputFormat::Tiff,
            &mut |value, message| {
                progress_events.push((value, message.to_string()));
                Ok(())
            },
        );
        assert!(response.ok, "{:?}", response.error);
        assert!(!progress_events.is_empty());

        let roi0_path = workspace_roi_tiff_path(&workspace.to_string_lossy(), 7, 0);
        let roi1_path = workspace_roi_tiff_path(&workspace.to_string_lossy(), 7, 1);
        assert!(roi0_path.is_file());
        assert!(roi1_path.is_file());

        let index_path = workspace_roi_index_path(&workspace.to_string_lossy(), 7);
        assert!(index_path.is_file());
        let index: serde_json::Value = serde_json::from_str(&fs::read_to_string(index_path).unwrap()).unwrap();
        assert_eq!(index["position"], 7);
        assert_eq!(index["axisOrder"], "TCZYX");
        assert_eq!(index["timeCount"], 2);
        assert_eq!(index["channelCount"], 2);
        assert_eq!(index["zCount"], 1);
        assert_eq!(index["rois"].as_array().unwrap().len(), 2);
        assert_eq!(index["rois"][0]["shape"], serde_json::json!([2, 2, 1, 2, 2]));

        let file = fs::File::open(&roi0_path).unwrap();
        let mut decoder = Decoder::new(BufReader::new(file)).unwrap();
        let mut pages = Vec::new();
        loop {
            match decoder.read_image().unwrap() {
                DecodingResult::U16(values) => pages.push(values),
                other => panic!("unexpected decoding result: {other:?}"),
            }
            if !decoder.more_images() {
                break;
            }
            decoder.next_image().unwrap();
        }

        assert_eq!(pages.len(), 4);
        assert_eq!(pages[0], vec![6u16, 7, 10, 11]);
        assert_eq!(pages[1], vec![106u16, 107, 110, 111]);
        assert_eq!(pages[2], vec![206u16, 207, 210, 211]);
        assert_eq!(pages[3], vec![306u16, 307, 310, 311]);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn loads_roi_frame_from_multipage_tiff() {
        let root = unique_temp_dir("view-load-roi-frame");
        let roi_dir = root.join("roi").join("Pos3");
        fs::create_dir_all(&roi_dir).unwrap();
        let index = RoiIndexFile {
            position: 3,
            axis_order: "TCZYX".to_string(),
            page_order: vec!["t".to_string(), "c".to_string(), "z".to_string()],
            time_count: 2,
            channel_count: 2,
            z_count: 1,
            source: ViewerSource::Nd2 {
                path: "/tmp/source.nd2".to_string(),
            },
            rois: vec![super::RoiIndexEntry {
                roi: 8,
                file_name: "Roi8.tif".to_string(),
                bbox: super::RoiBbox {
                    roi: 8,
                    x: 20,
                    y: 30,
                    w: 2,
                    h: 2,
                },
                shape: [2, 2, 1, 2, 2],
            }],
        };
        fs::write(
            roi_dir.join("index.json"),
            serde_json::to_vec_pretty(&index).unwrap(),
        )
        .unwrap();
        write_test_u16_tiff_pages(
            &roi_dir.join("Roi8.tif"),
            2,
            2,
            &[
                vec![1, 2, 3, 4],
                vec![11, 12, 13, 14],
                vec![21, 22, 23, 24],
                vec![31, 32, 33, 34],
            ],
        );

        let frame = load_roi_frame(
            root.to_string_lossy().to_string(),
            RoiFrameRequest {
                pos: 3,
                roi: 8,
                channel: 1,
                time: 1,
                z: 0,
            },
        )
        .unwrap();

        assert_eq!(frame.width, 2);
        assert_eq!(frame.height, 2);
        assert_eq!(frame.data, vec![31, 32, 33, 34]);

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn saves_and_loads_roi_frame_annotations_with_png_masks() {
        let root = unique_temp_dir("view-roi-annotation-roundtrip");
        let workspace = root.join("workspace");
        let roi_dir = workspace.join("roi").join("Pos3");
        let annotations_dir = workspace.join("annotations");
        fs::create_dir_all(&roi_dir).unwrap();
        fs::create_dir_all(&annotations_dir).unwrap();

        let index = RoiIndexFile {
            position: 3,
            axis_order: "TCZYX".to_string(),
            page_order: vec!["t".to_string(), "c".to_string(), "z".to_string()],
            time_count: 1,
            channel_count: 2,
            z_count: 1,
            source: ViewerSource::Nd2 {
                path: "/tmp/source.nd2".to_string(),
            },
            rois: vec![super::RoiIndexEntry {
                roi: 8,
                file_name: "Roi8.tif".to_string(),
                bbox: super::RoiBbox {
                    roi: 8,
                    x: 20,
                    y: 30,
                    w: 2,
                    h: 2,
                },
                shape: [1, 2, 1, 2, 2],
            }],
        };
        fs::write(
            roi_dir.join("index.json"),
            serde_json::to_vec_pretty(&index).unwrap(),
        )
        .unwrap();
        fs::write(
            workspace_annotation_labels_path(&workspace.to_string_lossy()),
            serde_json::json!([
                { "id": "cell", "name": "Cell", "color": "#22c55e" },
                { "id": "debris", "name": "Debris", "color": "#f97316" }
            ])
            .to_string(),
        )
        .unwrap();

        let mask_path = root.join("mask.png");
        write_test_png_mask(&mask_path, 2, 2, &[0, 1, 2, 1]);
        let mask_bytes = fs::read(&mask_path).unwrap();

        let request = RoiFrameRequest {
            pos: 3,
            roi: 8,
            channel: 1,
            time: 0,
            z: 0,
        };

        let saved = save_roi_frame_annotation(
            workspace.to_string_lossy().to_string(),
            request.clone(),
            RoiFrameAnnotationPayload {
                classification_label_id: Some("cell".to_string()),
                mask_base64_png: Some(BASE64_STANDARD.encode(mask_bytes.clone())),
            },
        )
        .unwrap();

        assert_eq!(saved.classification_label_id, Some("cell".to_string()));
        assert_eq!(
            saved.mask_path,
            Some("annotations/roi/Pos3/Roi8/C1_T0_Z0.png".to_string())
        );
        assert!(saved.updated_at.is_some());
        assert!(workspace_annotation_json_path(&workspace.to_string_lossy(), &request).is_file());
        assert!(workspace_annotation_mask_path(&workspace.to_string_lossy(), &request).is_file());

        let loaded = load_roi_frame_annotation(workspace.to_string_lossy().to_string(), request.clone()).unwrap();
        assert_eq!(
            loaded.annotation.classification_label_id,
            Some("cell".to_string())
        );
        assert_eq!(
            loaded.annotation.mask_path,
            Some("annotations/roi/Pos3/Roi8/C1_T0_Z0.png".to_string())
        );
        assert_eq!(loaded.mask_base64_png, Some(BASE64_STANDARD.encode(mask_bytes)));

        let cleared = save_roi_frame_annotation(
            workspace.to_string_lossy().to_string(),
            request.clone(),
            RoiFrameAnnotationPayload {
                classification_label_id: None,
                mask_base64_png: None,
            },
        )
        .unwrap();
        assert!(cleared.classification_label_id.is_none());
        assert!(cleared.mask_path.is_none());
        assert!(cleared.updated_at.is_none());
        assert!(!workspace_annotation_json_path(&workspace.to_string_lossy(), &request).exists());
        assert!(!workspace_annotation_mask_path(&workspace.to_string_lossy(), &request).exists());

        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn save_roi_frame_annotation_rejects_masks_with_unknown_class_indexes() {
        let root = unique_temp_dir("view-roi-annotation-invalid-mask");
        let workspace = root.join("workspace");
        let roi_dir = workspace.join("roi").join("Pos1");
        let annotations_dir = workspace.join("annotations");
        fs::create_dir_all(&roi_dir).unwrap();
        fs::create_dir_all(&annotations_dir).unwrap();

        let index = RoiIndexFile {
            position: 1,
            axis_order: "TCZYX".to_string(),
            page_order: vec!["t".to_string(), "c".to_string(), "z".to_string()],
            time_count: 1,
            channel_count: 1,
            z_count: 1,
            source: ViewerSource::Tif {
                path: "/tmp/images".to_string(),
            },
            rois: vec![super::RoiIndexEntry {
                roi: 0,
                file_name: "Roi0.tif".to_string(),
                bbox: super::RoiBbox {
                    roi: 0,
                    x: 0,
                    y: 0,
                    w: 2,
                    h: 2,
                },
                shape: [1, 1, 1, 2, 2],
            }],
        };
        fs::write(
            roi_dir.join("index.json"),
            serde_json::to_vec_pretty(&index).unwrap(),
        )
        .unwrap();
        fs::write(
            workspace_annotation_labels_path(&workspace.to_string_lossy()),
            serde_json::json!([{ "id": "cell", "name": "Cell", "color": "#22c55e" }]).to_string(),
        )
        .unwrap();

        let mask_path = root.join("bad-mask.png");
        write_test_png_mask(&mask_path, 2, 2, &[0, 2, 0, 0]);
        let error = save_roi_frame_annotation(
            workspace.to_string_lossy().to_string(),
            RoiFrameRequest {
                pos: 1,
                roi: 0,
                channel: 0,
                time: 0,
                z: 0,
            },
            RoiFrameAnnotationPayload {
                classification_label_id: Some("cell".to_string()),
                mask_base64_png: Some(BASE64_STANDARD.encode(fs::read(mask_path).unwrap())),
            },
        )
        .unwrap_err();

        assert!(error.contains("class index 2"));

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
