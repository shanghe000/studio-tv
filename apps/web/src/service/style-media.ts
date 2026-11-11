/** Exact public references from the immutable studio-style-library-1 catalog.
 * The API materializes pinned local bytes; the browser never imports arbitrary
 * remote URLs. These descriptors remain public across identity changes. */
export const builtinStyleMedia = [
 ['cinematic_realism','hero-canvas.webp'],
 ['anime_illustration','demo-poster.webp'],
 ['product_ad','examples/modular-speaker.webp'],
 ['editorial_fashion','examples/lime-rim-light.webp'],
].map(([resourceId,path])=>({url:'https://assets.example.invalid/styles/'+path,reference:{family:'PROMPT',resourceId,revision:1,path:'/preset/referenceImageUrl'}}));
