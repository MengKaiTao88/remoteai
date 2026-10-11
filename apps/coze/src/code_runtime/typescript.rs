use crate::error::{Error, Result};
use oxc::{
    allocator::Allocator,
    codegen::Codegen,
    parser::Parser,
    semantic::SemanticBuilder,
    span::SourceType,
    transformer::{TransformOptions, Transformer},
};
use std::path::Path;

pub fn transpile(source: &str) -> Result<String> {
    if source.len() > 100_000 {
        return Err(Error::Limit);
    }
    let allocator = Allocator::default();
    // Wrapping accepts the same function-body contract as the existing JS node.
    let source = format!("function __coze(input) {{\n{source}\n}}");
    let parsed = Parser::new(&allocator, &source, SourceType::ts()).parse();
    if !parsed.errors.is_empty() {
        return Err(Error::Workflow);
    }
    let mut program = parsed.program;
    let semantics = SemanticBuilder::new().build(&program);
    if !semantics.errors.is_empty() {
        return Err(Error::Workflow);
    }
    let options = TransformOptions::default();
    let transformed = Transformer::new(&allocator, Path::new("node.ts"), &options)
        .build_with_scoping(semantics.semantic.into_scoping(), &mut program);
    if !transformed.errors.is_empty() {
        return Err(Error::Workflow);
    }
    Ok(format!(
        "{}\nreturn __coze(input);",
        Codegen::new().build(&program).code
    ))
}
