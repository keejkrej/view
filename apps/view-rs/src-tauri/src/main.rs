use std::net::TcpListener;
use std::thread;

use core_rs::handle_ws_request;
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
                    let Some(response) = handle_ws_request(&text) else {
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
        .invoke_handler(tauri::generate_handler![pick_workspace, pick_tif, pick_nd2])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
