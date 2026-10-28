# PDF validation requirement

User requirement: PDFs issued from DuQana must include a QR code that opens the matching document or validation record on the DuQana website. Apply this to new document templates and new export paths as well as revisions to existing ones.

- Generate QR codes locally. Never send document tokens or customer data to an external QR service.
- Use the existing signed document token or purpose-scoped validation token. Never embed account access/refresh credentials.
- Preserve a clear quiet zone and sufficient print size. Test decoding from rendered PDF output.
- Include a clickable fallback link and an instruction to compare document details with the site.
- Do not describe a mutable document link as cryptographic proof that the PDF bytes have not been altered.

Quotation PDFs now include the signed public quotation link in classic, modern and minimal templates. Shared, authenticated-download and email attachment paths all use the same renderer/input mapper. Financial books already have signed validation stamps, and printed sales receipts already support verification QRs.

Validation: 595 backend tests passed. All three quotation templates were rendered and visually inspected, and each QR decoded successfully to its signed quotation route. No production deployment or physical paper scan was performed. Public QR links disclose the same details as the existing share link; treat them as bearer links.
