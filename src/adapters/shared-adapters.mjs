export function coerceTaskDetails(message) {
  if (typeof message === 'string') {
    return { task: message, context: {} };
  }
  return { task: message?.task || 'Untitled task', context: message || {} };
}
