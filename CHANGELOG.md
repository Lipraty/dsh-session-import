# Changelog

## 0.2.1

- Declare the package as an installable DSH bundle and include its composition patch in the distributed artifact.
- Align browser module registration and Host resource lookups with the `dsh-session-import` package name.
- Declare the browser's external modules for native graph ordering.
- Prefer plugin-manager Git installation in the README and LLM installation prompt; keep manual source loading as a development alternative.

No conversation, conversion-copy or source-archive data migration is performed by this packaging update.

## 0.2.0

Initial source release. It supported manual profile loading but omitted the bundle metadata required by the DSH plugin-manager installation flow.
