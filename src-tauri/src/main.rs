#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

#[derive(Clone, Serialize)]
struct PortSummary {
    name: String,
    kind: String,
}

struct ActiveConnection {
    writer: Box<dyn serialport::SerialPort>,
    stop: Arc<AtomicBool>,
}

#[derive(Default)]
struct AppState {
    connection: Mutex<Option<ActiveConnection>>,
}

#[tauri::command]
fn list_serial_ports() -> Result<Vec<PortSummary>, String> {
    let ports = serialport::available_ports().map_err(|e| e.to_string())?;
    Ok(ports.into_iter().map(|port| {
        let kind = match port.port_type {
            serialport::SerialPortType::UsbPort(info) => {
                let maker = info.manufacturer.unwrap_or_default();
                let product = info.product.unwrap_or_default();
                let label = format!("{} {}", maker, product).trim().to_string();
                if label.is_empty() { "USB serial".to_string() } else { label }
            }
            serialport::SerialPortType::BluetoothPort => "Bluetooth serial".to_string(),
            serialport::SerialPortType::PciPort => "PCI serial".to_string(),
            serialport::SerialPortType::Unknown => "Serial port".to_string(),
        };
        PortSummary { name: port.port_name, kind }
    }).collect())
}

#[tauri::command]
fn connect_serial(app: AppHandle, state: State<'_, AppState>, port_name: String, baud_rate: u32) -> Result<(), String> {
    if baud_rate == 0 { return Err("Baud rate must be greater than zero".into()); }
    let mut port = serialport::new(&port_name, baud_rate)
        .timeout(Duration::from_millis(60))
        .open()
        .map_err(|e| format!("Could not open {port_name}: {e}"))?;
    // Deassert DTR/RTS so auto-reset circuits don't push the ESP32 into bootloader mode.
    let _ = port.write_data_terminal_ready(false);
    let _ = port.write_request_to_send(false);
    let mut reader = port.try_clone().map_err(|e| format!("Could not create serial reader: {e}"))?;
    let stop = Arc::new(AtomicBool::new(false));
    let stop_reader = Arc::clone(&stop);

    {
        let mut slot = state.connection.lock().map_err(|_| "Serial connection lock was poisoned".to_string())?;
        if let Some(old) = slot.take() { old.stop.store(true, Ordering::Relaxed); }
        *slot = Some(ActiveConnection { writer: port, stop: Arc::clone(&stop) });
    }

    let reader_app = app.clone();
    thread::Builder::new().name("rangelab-serial-reader".into()).spawn(move || {
        let mut buffer = [0u8; 1024];
        while !stop_reader.load(Ordering::Relaxed) {
            match reader.read(&mut buffer) {
                Ok(0) => thread::sleep(Duration::from_millis(8)),
                Ok(n) => {
                    let chunk = String::from_utf8_lossy(&buffer[..n]).to_string();
                    let _ = reader_app.emit("serial-data", chunk);
                }
                Err(ref e) if e.kind() == std::io::ErrorKind::TimedOut || e.kind() == std::io::ErrorKind::WouldBlock => {}
                Err(e) => {
                    let _ = reader_app.emit("serial-error", e.to_string());
                    break;
                }
            }
        }
    }).map_err(|e| format!("Could not start serial reader: {e}"))?;
    Ok(())
}

#[tauri::command]
fn write_serial(state: State<'_, AppState>, data: String) -> Result<(), String> {
    if data.len() > 16_384 { return Err("Command payload is too large (16 KiB maximum)".into()); }
    let mut slot = state.connection.lock().map_err(|_| "Serial connection lock was poisoned".to_string())?;
    let active = slot.as_mut().ok_or_else(|| "No serial connection is open".to_string())?;
    active.writer.write_all(data.as_bytes()).map_err(|e| format!("Serial write failed: {e}"))?;
    active.writer.flush().map_err(|e| format!("Serial flush failed: {e}"))?;
    Ok(())
}

#[tauri::command]
fn disconnect_serial(state: State<'_, AppState>) -> Result<(), String> {
    let mut slot = state.connection.lock().map_err(|_| "Serial connection lock was poisoned".to_string())?;
    if let Some(active) = slot.take() { active.stop.store(true, Ordering::Relaxed); }
    Ok(())
}

fn main() {
    tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![list_serial_ports, connect_serial, write_serial, disconnect_serial])
        .run(tauri::generate_context!())
        .expect("error while running RangeLab");
}
