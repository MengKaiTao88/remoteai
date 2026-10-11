# Remote AI Coze runtime

Coze Studio reference source: https://github.com/coze-dev/coze-studio
Reference commit: fefb05ff27be1da939612fbf9faf5db62583b8ae
Copyright 2025 coze-dev Authors. Licensed under Apache-2.0.

This is a Rust reimplementation of the local services, not the upstream Go server.
The knowledge chunking, reciprocal rank retrieval, workflow graph concepts, and
resource publication lifecycle were adapted from that source. Remote AI changes
replace external infrastructure with SQLite, local files and CPU inference.
The Remote AI React editor and local API are independently implemented; they are
not a drop-in implementation of every upstream Coze HTTP/Thrift API.

Knowledge embeddings: intfloat/multilingual-e5-small, revision
614241f622f53c4eeff9890bdc4f31cfecc418b3, distributed under the MIT license.
See models/LICENSE in the release archive. Model card:
https://huggingface.co/intfloat/multilingual-e5-small

The package contains only the Rust executable, frontend assets, model files and
licenses. No Go server, Python environment, container images or external database
service is installed.
