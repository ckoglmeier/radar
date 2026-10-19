# Local PDF extraction cancellation

Version2.4.4-pdfocr.2 preserves per-page PDF/OCR evidence and fail-closed source
coverage. It makes parsing and rendering cancellable, not merely the native OCR
call. There are no new providers, keys, model choices or database migrations.

The production parser lives in a one-document Node child. A ten-minute maximum
monotonic budget starts before parsing; abort/deadline kills the parser with
SIGKILL and waits for exit before returning. Text, page information and rendering
all cross this boundary. The child has no inherited provider keys, workspace
tokens, Node arguments or generic command interface. It is process isolation for
work cancellation, not an OS sandbox against arbitrary same-user code.

OCR still uses the existing on-device helper. Abort/timeouts kill that helper,
wait for it to close, and remove its private temporary image. Original document
bytes are not changed. Rendering/page limits and OCR provenance are retained.
Active extraction reports an initial progress event and renews its supplied
claim callback every30seconds, including during initial parsing. The timer is
removed when work ends; there is no new idle poll. Consumers must abort when a
claim is lost. Progress callbacks are trusted application code, not PDF code.

`createParser` and `ocr` remain trusted dependency-injection seams for tests;
the production process guarantee does not make arbitrary injected JavaScript
cancellable. A promise race alone would leave a synchronous decoder running.

`npm run test:pdf-ocr` covers held and CPU-busy parse/info/render processes,
deadline/abort, pre-abort, late completion, claim renewal/revocation, helper exit
and temporary-file cleanup. Native Vision runs additionally when
`RADAR_IMAGE_OCR_PATH` points to the existing helper. Every fixture is synthetic.
Exact app packaging still needs to verify the parser process file/dependencies
and a raster/mixed PDF through its actual runtime before an installation.
