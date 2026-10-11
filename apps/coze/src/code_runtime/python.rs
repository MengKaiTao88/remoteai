use crate::{
    error::{Error, Result},
    jobs::JobControl,
};
use serde_json::{json, Value};
use std::{
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant},
};

const MAX_OUTPUT: u64 = 1024 * 1024;

pub fn execute(code: &str, input: Value, control: &JobControl) -> Result<Value> {
    execute_worker(&worker_path()?, code, input, control)
}

fn worker_path() -> Result<PathBuf> {
    let executable = std::env::current_exe()?;
    let mut directory = executable.parent().ok_or(Error::Invalid)?;
    // Cargo integration tests run under target/debug/deps, beside the build output directory.
    if directory.file_name().is_some_and(|name| name == "deps") {
        directory = directory.parent().ok_or(Error::Invalid)?;
    }
    Ok(directory.join(format!(
        "remoteai-coze-python{}",
        std::env::consts::EXE_SUFFIX
    )))
}

pub fn execute_worker(
    worker: &Path,
    code: &str,
    input: Value,
    control: &JobControl,
) -> Result<Value> {
    if code.len() > 100_000 || input.to_string().len() > MAX_OUTPUT as usize {
        return Err(Error::Limit);
    }
    control.check()?;
    let temporary = tempfile::tempdir()?;
    let mut command = Command::new(worker);
    super::platform::isolate(&mut command);
    command
        .current_dir(temporary.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut child = command.spawn()?;
    let payload = json!({"code":code,"input":input}).to_string().into_bytes();
    let result = exchange(&mut child, payload, control, deadline);
    stop(&mut child)?;
    result
}

fn exchange(
    child: &mut std::process::Child,
    payload: Vec<u8>,
    control: &JobControl,
    deadline: Instant,
) -> Result<Value> {
    let stdout = child.stdout.take().ok_or(Error::Invalid)?;
    let mut stdin = child.stdin.take().ok_or(Error::Invalid)?;
    let writer = std::thread::Builder::new()
        .name("coze-code-input".into())
        .spawn(move || stdin.write_all(&payload))?;
    let reader = std::thread::Builder::new()
        .name("coze-code-output".into())
        .spawn(move || {
            let mut output = Vec::new();
            stdout
                .take(MAX_OUTPUT + 1)
                .read_to_end(&mut output)
                .map(|_| output)
        });
    let reader = match reader {
        Ok(reader) => reader,
        Err(error) => {
            stop(child)?;
            writer.join().map_err(|_| Error::Workflow)??;
            return Err(error.into());
        }
    };
    let status = wait(child, control, deadline);
    // Kill before joining either pipe: a child may stop reading/writing at any time.
    stop(child)?;
    let sent = writer.join().map_err(|_| Error::Workflow)?;
    let output = reader.join().map_err(|_| Error::Workflow)?;
    let status = status?;
    sent?;
    let output = output?;
    if !status.success() || output.len() > MAX_OUTPUT as usize {
        return Err(Error::Workflow);
    }
    serde_json::from_slice(&output).map_err(|_| Error::Workflow)
}

fn wait(
    child: &mut std::process::Child,
    control: &JobControl,
    deadline: Instant,
) -> Result<std::process::ExitStatus> {
    loop {
        control.check()?;
        if Instant::now() > deadline {
            return Err(Error::Limit);
        }
        if let Some(status) = child.try_wait()? {
            return Ok(status);
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn stop(child: &mut std::process::Child) -> Result<()> {
    if child.try_wait()?.is_some() {
        return Ok(());
    }
    if let Err(error) = child.kill() {
        if child.try_wait()?.is_none() {
            return Err(error.into());
        }
    }
    child.wait()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "helper subprocess for the blocked-pipe cancellation test"]
    fn pipe_blocking_child() {
        std::thread::sleep(Duration::from_secs(30));
    }

    #[test]
    fn cancellation_interrupts_a_worker_that_never_reads_its_input() {
        let mut command = Command::new(std::env::current_exe().unwrap());
        super::super::platform::isolate(&mut command);
        let mut child = command
            .args([
                "--exact",
                "code_runtime::python::tests::pipe_blocking_child",
                "--ignored",
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let control = JobControl::detached();
        let cancel = control.clone();
        let trigger = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(100));
            cancel.cancel();
        });
        let start = Instant::now();
        let result = exchange(
            &mut child,
            vec![b'x'; 1024 * 1024],
            &control,
            start + Duration::from_secs(5),
        );
        trigger.join().unwrap();
        assert!(matches!(result, Err(Error::Cancelled)));
        assert!(start.elapsed() < Duration::from_secs(2));
        assert!(child.try_wait().unwrap().is_some());
    }
}
