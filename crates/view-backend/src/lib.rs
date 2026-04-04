use base64::prelude::{Engine as _, BASE64_STANDARD};
use serde::Serialize;

pub use view_domain::{
    AnnotationLabel, ContrastWindow, CropOutputFormat, CropRoiResponse, FrameRequest,
    LoadedRoiFrameAnnotation, RoiFrameAnnotation, RoiFrameAnnotationPayload, RoiFrameRequest,
    RoiWorkspaceScan, SaveBboxResponse, ViewerSource, WorkspaceScan,
};
use view_image::{apply_contrast, auto_contrast, contrast_domain, load_frame, RawFrame};

#[derive(Clone, Debug, Serialize)]
pub struct FramePayload {
    pub width: u32,
    pub height: u32,
    pub data_base64: String,
    pub pixel_type: &'static str,
    pub contrast_domain: ContrastWindow,
    pub suggested_contrast: ContrastWindow,
    pub applied_contrast: ContrastWindow,
}

fn to_frame_payload(raw: RawFrame, contrast: Option<ContrastWindow>) -> FramePayload {
    let domain = contrast_domain();
    let suggested = auto_contrast(&raw.data);
    let applied = contrast
        .as_ref()
        .map(view_image::normalize_contrast)
        .unwrap_or_else(|| suggested.clone());
    let pixels = apply_contrast(&raw.data, &applied);

    FramePayload {
        width: raw.width,
        height: raw.height,
        data_base64: BASE64_STANDARD.encode(pixels),
        pixel_type: "uint8",
        contrast_domain: domain,
        suggested_contrast: suggested,
        applied_contrast: applied,
    }
}

pub fn scan_source(source: ViewerSource) -> Result<WorkspaceScan, String> {
    view_image::scan_source(source)
}

pub fn load_frame_payload(
    source: ViewerSource,
    request: FrameRequest,
    contrast: Option<ContrastWindow>,
) -> Result<FramePayload, String> {
    load_frame(source, request).map(|raw| to_frame_payload(raw, contrast))
}

pub fn scan_roi_workspace(workspace_path: String) -> Result<RoiWorkspaceScan, String> {
    view_roi::scan_roi_workspace(workspace_path)
}

pub fn load_annotation_labels(workspace_path: String) -> Result<Vec<AnnotationLabel>, String> {
    view_roi::load_annotation_labels(workspace_path)
}

pub fn save_annotation_labels(
    workspace_path: String,
    labels: Vec<AnnotationLabel>,
) -> Result<Vec<AnnotationLabel>, String> {
    view_roi::save_annotation_labels(workspace_path, labels)
}

pub fn load_roi_frame_payload(
    workspace_path: String,
    request: RoiFrameRequest,
    contrast: Option<ContrastWindow>,
) -> Result<FramePayload, String> {
    view_roi::load_roi_frame(workspace_path, request).map(|raw| to_frame_payload(raw, contrast))
}

pub fn load_roi_frame_annotation(
    workspace_path: String,
    request: RoiFrameRequest,
) -> Result<LoadedRoiFrameAnnotation, String> {
    view_roi::load_roi_frame_annotation(workspace_path, request)
}

pub fn save_roi_frame_annotation(
    workspace_path: String,
    request: RoiFrameRequest,
    annotation: RoiFrameAnnotationPayload,
) -> Result<RoiFrameAnnotation, String> {
    view_roi::save_roi_frame_annotation(workspace_path, request, annotation)
}

pub fn save_bbox(workspace_path: String, pos: u32, csv: String) -> SaveBboxResponse {
    view_roi::save_bbox(workspace_path, pos, csv)
}

pub fn crop_roi<F>(
    workspace_path: String,
    source: ViewerSource,
    pos: u32,
    format: CropOutputFormat,
    progress: &mut F,
) -> CropRoiResponse
where
    F: FnMut(f64, &str) -> Result<(), String>,
{
    view_roi::crop_roi(workspace_path, source, pos, format, progress)
}
