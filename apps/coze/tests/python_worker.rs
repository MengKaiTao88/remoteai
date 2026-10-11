use remoteai_coze::{code_runtime::python::execute_worker, jobs::JobControl};
use serde_json::json;
use std::path::Path;

#[test]
fn python_runs_async_upstream_contract_and_rejects_host_access() {
    let worker = Path::new(env!("CARGO_BIN_EXE_remoteai-coze-python"));
    let control = JobControl::detached();
    let output = execute_worker(
        worker,
        "async def main(args: Args) -> Output:\n    return {'sum': sum(args.params['values'])}",
        json!({"values":[1,2,3]}),
        &control,
    )
    .unwrap();
    assert_eq!(output, json!({"sum":6}));
    assert!(execute_worker(
        worker,
        "async def main(args):\n    return open('secret.txt').read()",
        json!({}),
        &control
    )
    .is_err());
    assert!(execute_worker(worker,
        "async def main(args):\n    import subprocess\n    return subprocess.check_output(['whoami'])",
        json!({}), &control).is_err());
}

#[test]
fn python_limits_time_memory_and_honors_cancel() {
    let worker = Path::new(env!("CARGO_BIN_EXE_remoteai-coze-python"));
    let control = JobControl::detached();
    assert!(execute_worker(
        worker,
        "async def main(args):\n    while True: pass",
        json!({}),
        &control
    )
    .is_err());
    assert!(execute_worker(
        worker,
        "async def main(args):\n    return 'x' * 1000000000",
        json!({}),
        &control
    )
    .is_err());
    control.cancel();
    assert!(matches!(
        execute_worker(
            worker,
            "async def main(args):\n    return 1",
            json!({}),
            &control
        ),
        Err(remoteai_coze::error::Error::Cancelled)
    ));
}
