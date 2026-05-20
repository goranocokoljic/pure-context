#[cfg(target_os = "linux")]
pub fn linux_send() -> bool {
    true
}

#[cfg(target_os = "windows")]
pub fn windows_send() -> bool {
    false
}

#[cfg(feature = "io")]
pub struct IoStream {
    pub fd: i32,
}

pub fn uncfg_function() -> u32 {
    42
}
