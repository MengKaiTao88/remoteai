//! Disposable Python node worker. No host modules, mounts, callbacks or credentials are provided.
use monty::MontyRun;
use monty_types::{CompileOptions, MontyObject, PrintWriter, ResourceLimits, ResourceTracker};
use serde::Deserialize;
use serde_json::Value;
use std::{
    io::{Read, Write},
    time::Duration,
};

#[global_allocator]
static ALLOCATOR: monty_alloc::LimitedAllocator = monty_alloc::LimitedAllocator;
const SOFT_MEMORY: usize = 64 * 1024 * 1024;
const HARD_MEMORY: usize = 96 * 1024 * 1024;
const MAX_INPUT: u64 = 2 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    code: String,
    input: Value,
}

fn main() {
    if let Err(error) = run() {
        eprintln!("Python node failed: {error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), Box<dyn std::error::Error>> {
    let mut input = Vec::with_capacity(4096);
    monty_alloc::set_hard_limit(Some(HARD_MEMORY))?;
    std::io::stdin()
        .take(MAX_INPUT + 1)
        .read_to_end(&mut input)?;
    if input.len() as u64 > MAX_INPUT {
        return Err("input limit".into());
    }
    let request: Request = serde_json::from_slice(&input)?;
    if request.code.len() > 100_000 {
        return Err("code limit".into());
    }
    let source = format!(
        "import json\nclass Args:\n    def __init__(self, params):\n        self.params = params\n\
        Output = dict\ninput = json.loads(__input_json)\n{}\njson.dumps(await main(Args(input)))",
        request.code
    );
    let mut runner = MontyRun::new(
        source,
        "workflow.py",
        vec!["__input_json".into()],
        CompileOptions::default(),
    )?;
    let limits = ResourceLimits {
        max_memory: Some(SOFT_MEMORY),
        max_feed_duration: Some(Duration::from_secs(2)),
        max_turn_duration: Some(Duration::from_secs(2)),
        ..ResourceLimits::default()
    };
    let output = runner.run(
        vec![MontyObject::string(request.input.to_string())],
        ResourceTracker::new(limits),
        PrintWriter::Disabled,
    )?;
    let value = output.as_ref();
    let text = value.as_str().ok_or("output format")?;
    if text.len() > 1024 * 1024 {
        return Err("output limit".into());
    }
    let result: Value = serde_json::from_str(text)?;
    std::io::stdout().write_all(result.to_string().as_bytes())?;
    Ok(())
}
