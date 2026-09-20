# Real-document benchmark workspace

This directory defines the private Order 3 benchmark format. It contains no real
supplier documents or labels.

Keep the working set under the gitignored `.molecule-data/order3/` directory:

```text
.molecule-data/order3/
  raw/                         authorized immutable source files
  manifest.json               checksums, authorization and source metadata
  reviewer-a.json              first independent labels
  reviewer-b.json              second independent labels
  adjudicated.json             final labels plus disagreement notes
  resolution-snapshot.json     frozen run-specific resolution evidence
```

Do not commit source text, filenames, evidence spans, reviewer identities or
supplier identifiers. A later sanitized report may contain aggregate counts,
metrics and non-identifying failure categories only.

All JSON is strict. The executable shape and semantic checks live in
`schema.mjs`. Labels record what each source states; they do not guess current
operational truth. A capacity number with no stated period can be labelled, but
its expected handling cannot be `claim`.

Validate a completed private bundle with:

```sh
node rox_data/benchmark/validate.mjs \
  --manifest=.molecule-data/order3/manifest.json \
  --reviewer-a=.molecule-data/order3/reviewer-a.json \
  --reviewer-b=.molecule-data/order3/reviewer-b.json \
  --adjudicated=.molecule-data/order3/adjudicated.json \
  --raw=.molecule-data/order3/raw
```

Validation checks explicit authorization and de-identification review, unique
document IDs and content, safe relative paths, current file checksums, complete
coverage by two distinct reviewers, and documented adjudication of every label
disagreement. It does not establish that authorization claims or human labels
are true; those remain human responsibilities.
