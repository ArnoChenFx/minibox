/** The REST header that names the client session a request belongs to. */
export const RUN_HEADER = "X-Minibox-Run";

/** Letters, digits, dots, colons, underscores and hyphens, starting with a letter or digit, at most 64 characters. */
export const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
