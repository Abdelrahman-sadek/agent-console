# Privacy & Redaction Pipeline

You are using the `compliance/pii_masker` skill.
Use this skill whenever you are handling text that contains sensitive user data (Names, Emails, Physical Addresses, Crypto Wallets, etc.) and you need to pass it to external tools, APIs, or less secure environments.

This acts as a "Privacy Firewall". Depending on your use case, set the `mode` parameter to `mask` if you need to retain contextual semantic tags (e.g., `[PERSON_1]`), or `redact`/`remove` if you need to completely obscure the information before proceeding.
