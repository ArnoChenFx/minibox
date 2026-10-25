//! The preview relay that runs inside a box as `dev`.
//!
//! Usage: `minibox-relay <port>`. It connects to that port on the box's loopback, answers `ok` or
//! `err <why>` as its first line, and then copies bytes between standard input and that
//! connection, and back to standard output. The behaviour matches the python3 relay it replaces
//! (src/preview/relay.ts), so the server's handshake and byte copying are unchanged.
//!
//! Standard output is written through the raw fd 1, not `std::io::stdout()`: that is a line
//! buffer, and forwarded bytes without a newline would sit in the process until a newline or a
//! full buffer, stalling every preview whose body has neither. `File` has no buffering. The file
//! is wrapped in `ManuallyDrop` so a drop never closes fd 1.
//!
//! Only libstd is used, so a `x86_64-unknown-linux-musl` / `aarch64-unknown-linux-musl` build is
//! a static single binary with no runtime dependencies in the box.

use std::fs::File;
use std::io::{Read, Write};
use std::mem::ManuallyDrop;
use std::net::{TcpStream, ToSocketAddrs};
use std::os::unix::io::{AsRawFd, FromRawFd};
use std::time::Duration;

/// Connection timeout for the dial to the service on the box's loopback. The server's handshake
/// gives the relay 10 seconds to answer, so this sits inside it.
const DIAL_TIMEOUT: Duration = Duration::from_secs(10);

/// Copies `data` to the stream, tolerating short writes. A failure ends the caller's loop.
fn emit(stream: &mut impl Write, mut data: &[u8]) {
    while !data.is_empty() {
        match stream.write(data) {
            Ok(0) => break,
            Ok(n) => data = &data[n..],
            Err(_) => break,
        }
    }
}

/// The relay's readable descriptors: the service connection always, and standard input only while
/// it has not reached its end. Returns which of the two is ready; an error or timeout yields
/// nothing, and the caller treats that as the connection ending.
fn wait_readable(up: &TcpStream, stdin_open: bool) -> Option<(bool, bool)> {
    #[repr(C)]
    struct PollFd {
        fd: i32,
        events: i16,
        revents: i16,
    }
    extern "C" {
        fn poll(fds: *mut PollFd, nfds: u64, timeout: i32) -> i32;
    }
    const POLLIN: i16 = 0x001;

    let mut fds = vec![PollFd { fd: up.as_raw_fd(), events: POLLIN, revents: 0 }];
    if stdin_open {
        fds.push(PollFd { fd: 0, events: POLLIN, revents: 0 });
    }
    let n = unsafe { poll(fds.as_mut_ptr(), fds.len() as u64, -1) };
    if n <= 0 {
        return None;
    }
    // Standard input is fd 0 and the connection is not, so the fd alone tells the two apart.
    let up_ready = fds[0].revents != 0;
    let stdin_ready = stdin_open && fds[1].revents != 0;
    Some((up_ready, stdin_ready))
}

fn run() -> i32 {
    let port: u16 = match std::env::args().nth(1).and_then(|a| a.parse().ok()) {
        Some(port) => port,
        None => {
            emit(&mut std::io::stderr(), b"usage: minibox-relay <port>\n");
            return 2;
        }
    };

    // Raw fd 1, unbuffered, never closed (see the module comment).
    let mut out = unsafe { ManuallyDrop::new(File::from_raw_fd(1)) };
    let addr = match ("127.0.0.1", port).to_socket_addrs() {
        Ok(mut addrs) => match addrs.next() {
            Some(addr) => addr,
            None => {
                emit(&mut *out, b"err no address for 127.0.0.1\n");
                return 1;
            }
        },
        Err(_) => {
            emit(&mut *out, b"err cannot resolve 127.0.0.1\n");
            return 1;
        }
    };
    let mut up = match TcpStream::connect_timeout(&addr, DIAL_TIMEOUT) {
        Ok(up) => up,
        Err(error) => {
            let line = format!("err {}\n", error.to_string().replace('\n', " "));
            emit(&mut *out, line.as_bytes());
            return 1;
        }
    };
    let _ = up.set_nodelay(true);
    emit(&mut *out, b"ok\n");

    let mut stdin_open = true;
    let mut buffer = [0u8; 65536];
    loop {
        let (up_ready, stdin_ready) = match wait_readable(&up, stdin_open) {
            Some(ready) => ready,
            None => break,
        };
        if up_ready {
            match up.read(&mut buffer) {
                Ok(0) => break,
                Ok(n) => emit(&mut *out, &buffer[..n]),
                Err(_) => break,
            }
        }
        if stdin_ready {
            match std::io::stdin().read(&mut buffer) {
                Ok(0) => {
                    stdin_open = false;
                    let _ = up.shutdown(std::net::Shutdown::Write);
                }
                Ok(n) => {
                    if up.write_all(&buffer[..n]).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    }
    0
}

fn main() {
    std::process::exit(run());
}
