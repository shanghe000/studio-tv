-- Recover existing placeholder titles from the first visible user message
-- containing effective TEXT. Preserve custom titles, empty conversations,
-- deleted history, receipt evidence and the original history ordering.
-- Match domain.compactTitleText: Unicode whitespace and C0/C1 controls.
ALTER TABLE assistant.conversations ADD COLUMN title_generated boolean NOT NULL DEFAULT false;

CREATE FUNCTION assistant.compact_title_text(value text) RETURNS text
LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT btrim(regexp_replace(value,U&'[\0001-\0020\007F-\009F\00A0\1680\2000-\200A\2028\2029\202F\205F\3000]+',' ','g'))
$$;

WITH suggestions AS (
 SELECT c.id,CASE WHEN char_length(first_text.text)>32
   THEN rtrim(left(first_text.text,31))||'…' ELSE first_text.text END AS title
 FROM assistant.conversations c
 CROSS JOIN LATERAL (
   SELECT assistant.compact_title_text(string_agg(part.value->>'text',' ' ORDER BY part.ordinality)) AS text
   FROM assistant.messages m
   CROSS JOIN LATERAL jsonb_array_elements(m.content) WITH ORDINALITY AS part(value,ordinality)
   WHERE m.conversation_id=c.id AND m.owner_id=c.owner_id AND m.role='USER' AND m.deleted_at IS NULL
     AND part.value->>'type'='TEXT'
   GROUP BY m.sequence,m.id
   HAVING assistant.compact_title_text(string_agg(part.value->>'text',' ' ORDER BY part.ordinality))<>''
   ORDER BY m.sequence,m.id LIMIT 1
 ) first_text
 WHERE c.deleted_at IS NULL AND assistant.compact_title_text(c.title) IN ('','新对话')
)
UPDATE assistant.conversations c SET title=s.title,title_generated=true,revision=c.revision+1
FROM suggestions s WHERE c.id=s.id;

DROP FUNCTION assistant.compact_title_text(text);
