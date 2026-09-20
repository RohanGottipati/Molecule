# Order 3: real-document benchmark

Status: **in progress** on 2026-09-19 Toronto / 2026-09-20 UTC.

The repository contains no authorized real supplier-capacity documents. Existing
ROX inbox material is synthetic and cannot satisfy this order. No real accuracy
result is available.

The reusable benchmark boundary is implemented under
[`rox_data/benchmark`](../rox_data/benchmark/README.md). It requires:

- immutable source checksums and safe private paths;
- explicit authorization and de-identification review per document;
- one label for every selected document, including irrelevant/empty cases;
- two distinct independent reviewers;
- final adjudication with notes for every disagreement; and
- no promotion of a capacity number whose period is unstated.

Private files belong under `.molecule-data/order3/`, which is already gitignored.
The validator reads them locally and emits counts only. It does not upload
documents, call a model, write to Tiger or verify that the human authorization
and labels are truthful.

## Remaining completion evidence

1. The data owner supplies a small set of authorized documents for the selected
   embroidery supplier scenario.
2. A human records authorization and completes de-identification review.
3. Two people label the documents independently without viewing pipeline output.
4. Disagreements are adjudicated and the private bundle passes the validator.
5. A frozen run-specific resolution snapshot is produced.
6. Only aggregate, sanitized real-versus-synthetic results are committed.

Until those steps exist, Order 3 remains incomplete and Order 4 accuracy work
must not be presented as benchmark-driven improvement.
