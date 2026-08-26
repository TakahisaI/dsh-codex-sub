export async function resolve(specifier, context, defaultResolve) {
  if (specifier.endsWith('.js') && context.parentURL?.includes('/src/')) {
    try {
      return await defaultResolve(`${specifier.slice(0, -3)}.ts`, context, defaultResolve)
    } catch {
      // Keep the normal resolver's diagnostic for unrelated JavaScript imports.
    }
  }
  return defaultResolve(specifier, context, defaultResolve)
}
