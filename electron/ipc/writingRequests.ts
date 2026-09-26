/** Both writing entrypoints share one active request per renderer window. */
export const writingRequestControllers = new Map<string, AbortController>();
