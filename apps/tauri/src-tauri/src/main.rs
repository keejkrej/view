use std::net::TcpListener;
use std::path::Path;
use std::thread;

use core_rs::handle_ws_request_with_progress;
use rfd::FileDialog;
use tauri::command;
use tungstenite::{accept, Message};

const BACKEND_PORT: u16 = 47834;

#[command]
fn pick_workspace() -> Option<String> {
    FileDialog::new()
        .pick_folder()
        .map(|path| path.to_string_lossy().to_string())
}

#[command]
fn pick_tif() -> Option<String> {
    FileDialog::new()
        .pick_folder()
        .map(|path| path.to_string_lossy().to_string())
}

#[command]
fn pick_nd2() -> Option<String> {
    FileDialog::new()
        .add_filter("ND2", &["nd2"])
        .pick_file()
        .map(|path| path.to_string_lossy().to_string())
}

#[command]
fn roi_pos_exists(workspace_path: String, pos: u32) -> bool {
    Path::new(&workspace_path)
        .join("roi")
        .join(format!("Pos{pos}"))
        .is_dir()
}

fn start_backend_server() {
    thread::spawn(|| {
        let listener = TcpListener::bind(("127.0.0.1", BACKEND_PORT))
            .expect("failed to bind websocket backend");

        for stream in listener.incoming() {
            let Ok(stream) = stream else {
                continue;
            };

            thread::spawn(move || {
                let Ok(mut websocket) = accept(stream) else {
                    return;
                };

                loop {
                    let message = match websocket.read() {
                        Ok(message) => message,
                        Err(_) => break,
                    };

                    if message.is_close() {
                        break;
                    }

                    if !message.is_text() {
                        continue;
                    }

                    let Ok(text) = message.into_text() else {
                        continue;
                    };
                    let Some(response) = handle_ws_request_with_progress(&text, |progress| {
                        websocket
                            .send(Message::Text(progress))
                            .map_err(|err| format!("Crop aborted because the viewer connection closed: {err}"))
                    }) else {
                        continue;
                    };

                    if websocket.send(Message::Text(response)).is_err() {
                        break;
                    }
                }
            });
        }
    });
}

fn main() {
    start_backend_server();

    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            pick_workspace,
            pick_tif,
            pick_nd2,
            roi_pos_exists
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
