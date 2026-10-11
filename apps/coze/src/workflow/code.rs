use crate::error::{Error, Result};
use rquickjs::{Context, Function, Runtime, Value as JsValue};
use serde_json::Value;
use std::time::{Duration, Instant};

const MEMORY_LIMIT: usize = 32 * 1024 * 1024;
const STACK_LIMIT: usize = 256 * 1024;
const CODE_LIMIT: usize = 100_000;

/// Each call gets a fresh JS VM with no host functions, filesystem, networking or module loader.
pub(super) fn execute(code: &str, input: Value) -> Result<Value> {
    if code.len() > CODE_LIMIT || input.to_string().len() > 1024 * 1024 {
        return Err(Error::Limit);
    }
    let runtime = Runtime::new().map_err(|_| Error::Workflow)?;
    runtime.set_memory_limit(MEMORY_LIMIT);
    runtime.set_max_stack_size(STACK_LIMIT);
    let deadline = Instant::now() + Duration::from_secs(2);
    runtime.set_interrupt_handler(Some(Box::new(move || Instant::now() > deadline)));
    let context = Context::full(&runtime).map_err(|_| Error::Workflow)?;
    context.with(|ctx| {
        let function: Function = ctx
            .eval(format!("(function(input) {{ 'use strict';\n{code}\n}})"))
            .map_err(|_| Error::Workflow)?;
        let argument = ctx
            .json_parse(input.to_string())
            .map_err(|_| Error::Workflow)?;
        let result: JsValue = function.call((argument,)).map_err(|_| Error::Workflow)?;
        let text = ctx
            .json_stringify(result)
            .map_err(|_| Error::Workflow)?
            .ok_or(Error::Workflow)?
            .to_string()
            .map_err(|_| Error::Workflow)?;
        if text.len() > 1024 * 1024 {
            return Err(Error::Limit);
        }
        serde_json::from_str(&text).map_err(|_| Error::Workflow)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn code_transforms_input_without_host_capabilities() {
        assert_eq!(
            execute("return {sum: input.a + input.b};", json!({"a":2,"b":3})).unwrap(),
            json!({"sum":5})
        );
        assert!(execute(
            "return require('fs').readFileSync('/etc/passwd');",
            json!({})
        )
        .is_err());
        assert!(execute("return process.env;", json!({})).is_err());
    }

    #[test]
    fn infinite_loops_and_unbounded_allocations_are_interrupted() {
        assert!(execute("while (true) {}", json!({})).is_err());
        assert!(execute("return 'x'.repeat(200000000);", json!({})).is_err());
    }
}
