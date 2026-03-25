use std::collections::BTreeSet;
use std::fs::{self, File};
use std::io::BufReader;
use std::path::{Path, PathBuf};

use rfd::FileDialog;
use serde::Serialize;
use tauri::command;
use tiff::decoder::{Decoder, DecodingResult};
use walkdir::WalkDir;

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

#[derive(serde::Deserialize)]
struct FrameRequest {
    pos: u32,
    channel: u32,
    time: u32,
    z: u32,
}

#[derive(Serialize)]
struct FrameResponse {
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
        DecodingResult::U8(values) => collapse_channels(values.into_iter().map(|value| (value as u16) * 257).collect()),
        DecodingResult::U16(values) => collapse_channels(values),
        DecodingResult::I8(values) => collapse_channels(
            values
                .into_iter()
                .map(|value| (value.max(0) as u16) * 257)
                .collect(),
        ),
        DecodingResult::I16(values) => collapse_channels(
            values
                .into_iter()
                .map(|value| value.clamp(0, u16::MAX as i16) as u16)
                .collect(),
        ),
        DecodingResult::U32(values) => collapse_channels(
            values
                .into_iter()
                .map(|value| value.min(u16::MAX as u32) as u16)
                .collect(),
        ),
        DecodingResult::I32(values) => collapse_channels(
            values
                .into_iter()
                .map(|value| value.clamp(0, u16::MAX as i32) as u16)
                .collect(),
        ),
        DecodingResult::F32(values) => collapse_channels(
            values
                .into_iter()
                .map(|value| value.clamp(0.0, u16::MAX as f32) as u16)
                .collect(),
        ),
        DecodingResult::F64(values) => collapse_channels(
            values
                .into_iter()
                .map(|value| value.clamp(0.0, u16::MAX as f64) as u16)
                .collect(),
        ),
        _ => Err("Unsupported TIFF pixel type".to_string()),
    }
}

fn load_tiff_frame(path: &Path) -> Result<FrameResponse, String> {
    let file = File::open(path).map_err(|err| err.to_string())?;
    let mut decoder = Decoder::new(BufReader::new(file)).map_err(|err| err.to_string())?;
    let (width, height) = decoder.dimensions().map_err(|err| err.to_string())?;
    let image = decoder.read_image().map_err(|err| err.to_string())?;
    let data = to_u16_buffer(width, height, image)?;
    Ok(FrameResponse { width, height, data })
}

fn bbox_csv_path(root: &str, pos: u32) -> PathBuf {
    Path::new(root).join(format!("Pos{pos}_bbox.csv"))
}

#[command]
fn pick_workspace() -> Option<String> {
    FileDialog::new()
        .pick_folder()
        .map(|path| path.to_string_lossy().to_string())
}

#[command]
fn scan_workspace(root: String) -> Result<WorkspaceScan, String> {
    let root_path = Path::new(&root);
    let entries = fs::read_dir(root_path).map_err(|err| err.to_string())?;
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

#[command]
fn load_frame(root: String, request: FrameRequest) -> Result<FrameResponse, String> {
    let pos_dir = find_position_dir(Path::new(&root), request.pos)?;
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

#[command]
fn save_bbox(root: String, pos: u32, csv: String) -> SaveBboxResponse {
    if let Err(error) = fs::create_dir_all(&root) {
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

    match fs::write(bbox_csv_path(&root, pos), normalized) {
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

fn main() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![pick_workspace, scan_workspace, load_frame, save_bbox])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    use super::{bbox_csv_path, parse_pos_dir_name, parse_tiff_name, save_bbox};

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
    fn save_bbox_writes_expected_file_name_with_trailing_newline() {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!("view-tauri-save-bbox-{unique}"));
        let root_string = root.to_string_lossy().to_string();

        let result = save_bbox(root_string.clone(), 7, "crop,x,y,w,h\n0,1,2,3,4".to_string());
        assert!(result.ok);

        let saved_path = bbox_csv_path(&root_string, 7);
        let saved = fs::read_to_string(&saved_path).unwrap();
        assert_eq!(saved, "crop,x,y,w,h\n0,1,2,3,4\n");

        let _ = fs::remove_file(saved_path);
        let _ = fs::remove_dir_all(root);
    }
}
