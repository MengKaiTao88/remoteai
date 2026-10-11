use super::{
    bindings::{render, resolve},
    NodeAction, RuntimeContext,
};
use crate::{
    error::{Error, Result},
    tables,
};
use serde_json::Value;

pub(super) fn evaluate(
    context: &RuntimeContext<'_>,
    action: &NodeAction,
    values: &Value,
) -> Result<Value> {
    let db = &context.services.db;
    match action {
        NodeAction::Conversation { operation, input } => {
            super::conversations::execute(context.services, *operation, resolve(input, values)?)
        }
        NodeAction::TableQuery { table_id, filter } => {
            tables::query(db, table_id, &resolve(filter, values)?)
        }
        NodeAction::TableWrite { table_id, value } => {
            tables::write(db, table_id, None, resolve(value, values)?)
        }
        NodeAction::TableUpdate {
            table_id,
            row_id,
            value,
        } => tables::update(
            db,
            table_id,
            &render(row_id, values)?,
            resolve(value, values)?,
        ),
        NodeAction::TableDelete { table_id, row_id } => {
            tables::delete(db, table_id, &render(row_id, values)?)
        }
        NodeAction::Sql { table_ids, sql } => tables::run_sql(
            db,
            tables::SqlRequest {
                tables: table_ids.clone(),
                sql: render(sql, values)?,
            },
        ),
        NodeAction::Nl2sql {
            table_ids,
            model,
            question,
        } => tables::generate_sql(
            db,
            &context.services.proxy,
            tables::GenerateSqlRequest {
                tables: table_ids.clone(),
                model: model.clone(),
                question: render(question, values)?,
            },
        ),
        _ => Err(Error::Workflow),
    }
}
