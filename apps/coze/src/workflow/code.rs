use crate::error::{Error, Result};
use crate::{code_runtime::Language, jobs::JobControl};
use rquickjs::{Context, Function, Runtime, Value as JsValue};
use serde_json::Value;
use std::time::{Duration, Instant};

const MEMORY_LIMIT: usize = 32 * 1024 * 1024;
const STACK_LIMIT: usize = 256 * 1024;
const CODE_LIMIT: usize = 100_000;

pub(super) fn execute_node(
    settings: (Language, bool),
    code: &str,
    input: Value,
    control: &JobControl,
) -> Result<Value> {
    if matches!(settings.0, Language::Python) {
        return crate::code_runtime::python::execute(code, input, control);
    }
    let code = if settings.1 {
        format!("{code}\nreturn main({{params:input}});")
    } else {
        code.to_owned()
    };
    let code = crate::code_runtime::javascript(settings.0, &code)?;
    execute_controlled(&code, input, control)
}

/// Each call gets a fresh JS VM with no host functions, filesystem, networking or module loader.
#[cfg(test)]
fn execute(code: &str, input: Value) -> Result<Value> {
    execute_controlled(code, input, &JobControl::detached())
}

fn execute_controlled(code: &str, input: Value, control: &JobControl) -> Result<Value> {
    if code.len() > CODE_LIMIT || input.to_string().len() > 1024 * 1024 {
        return Err(Error::Limit);
    }
    let runtime = Runtime::new().map_err(|_| Error::Workflow)?;
    runtime.set_memory_limit(MEMORY_LIMIT);
    runtime.set_max_stack_size(STACK_LIMIT);
    let deadline = Instant::now() + Duration::from_secs(2);
    let interrupt = control.clone();
    runtime.set_interrupt_handler(Some(Box::new(move || {
        Instant::now() > deadline || interrupt.is_cancelled()
    })));
    let context = Context::full(&runtime).map_err(|_| Error::Workflow)?;
    context.with(|ctx| {
        let function: Function = ctx
            .eval(format!("(function(input) {{ 'use strict';\n{code}\n}})"))
            .map_err(|_| Error::Workflow)?;
        let argument = ctx
            .json_parse(input.to_string())
            .map_err(|_| Error::Workflow)?;
        let result: JsValue = function.call((argument,)).map_err(|_| Error::Workflow)?;
        let result = match result.as_promise() {
            Some(promise) => promise.finish::<JsValue>().map_err(|_| Error::Workflow)?,
            None => result,
        };
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
    fn typescript_accepts_types_and_async_upstream_main() {
        let source = "interface Args { params: { n: number } }\n\
            async function main(args: Args): Promise<{sum: number}> { return {sum: args.params.n + 1}; }";
        assert_eq!(
            execute_node(
                (Language::Typescript, true),
                source,
                json!({"n": 4}),
                &JobControl::detached()
            )
            .unwrap(),
            json!({"sum":5})
        );
    }

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
