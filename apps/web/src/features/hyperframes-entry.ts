/** Temporarily remove the canvas header entry. The editor, embedded player
 * and service APIs remain available for existing saved content. Installing
 * this before the native UI mounts also covers its asynchronous remounts. */
export const hyperframesEntryStyles='body button.hyperframes-btn{display:none!important}';
