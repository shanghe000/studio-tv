-- Keep existing compiled catalog assets and admit only content-addressed STUDIO
-- character WebP files. Existing rows are validated and retained during upgrade.
ALTER TABLE resources.catalog_media DROP CONSTRAINT catalog_media_path_check;
ALTER TABLE resources.catalog_media ADD CONSTRAINT catalog_media_path_check CHECK (
    (path LIKE '/project/assets/%' AND position('..' in path)=0)
    OR (octet_length(path)=89 AND path ~ '^/studio-character-media/[a-f0-9]{64}[.]webp$')
);
