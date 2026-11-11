package postgres

import (
	"context"
	"encoding/json"
	"github.com/jackc/pgx/v5"
	"studiotv.local/service/api/internal/modules/organization/application"
	"studiotv.local/service/api/internal/modules/organization/domain"
)

const notificationFields = "id,type,title,body,(read_at IS NOT NULL),target_url,created_at,revision"

func scanNotification(row pgx.Row) (domain.Notification, error) {
	var n domain.Notification
	var title, body []byte
	e := row.Scan(&n.ID, &n.Type, &title, &body, &n.Read, &n.TargetURL, &n.CreatedAt, &n.Revision)
	if e != nil {
		return n, unavailable(e)
	}
	if json.Unmarshal(title, &n.Title) != nil || json.Unmarshal(body, &n.Body) != nil {
		return n, domain.ErrUnavailable
	}
	n.CreatedAt = n.CreatedAt.UTC()
	return n, nil
}
func notification(ctx context.Context, tx pgx.Tx, a domain.Actor, id string) (domain.Notification, error) {
	return scanNotification(tx.QueryRow(ctx, "SELECT "+notificationFields+" FROM organization.notifications WHERE id=$1 AND owner_id=$2 AND deleted_at IS NULL", id, a.OwnerID))
}
func (r *Repository) Notification(ctx context.Context, a domain.Actor, id string) (domain.Notification, error) {
	var n domain.Notification
	e := r.within(ctx, true, func(tx pgx.Tx) error { var e error; n, e = notification(ctx, tx, a, id); return e })
	return n, e
}
func (r *Repository) Notifications(ctx context.Context, a domain.Actor, kind string, page, size int) (domain.NotificationPage, error) {
	v := domain.NotificationPage{Items: []domain.Notification{}, Page: page, PageSize: size}
	e := r.within(ctx, true, func(tx pgx.Tx) error {
		e := tx.QueryRow(ctx, "SELECT count(*) FROM organization.notifications WHERE owner_id=$1 AND deleted_at IS NULL AND ($2='' OR type=$2)", a.OwnerID, kind).Scan(&v.Total)
		if e != nil {
			return unavailable(e)
		}
		rows, e := tx.Query(ctx, "SELECT "+notificationFields+" FROM organization.notifications WHERE owner_id=$1 AND deleted_at IS NULL AND ($2='' OR type=$2) ORDER BY created_at DESC,id LIMIT $3 OFFSET $4", a.OwnerID, kind, size, int64(page-1)*int64(size))
		if e != nil {
			return unavailable(e)
		}
		defer rows.Close()
		for rows.Next() {
			n, e := scanNotification(rows)
			if e != nil {
				return e
			}
			v.Items = append(v.Items, n)
		}
		v.HasMore = int64(page)*int64(size) < v.Total
		return unavailable(rows.Err())
	})
	return v, e
}
func unread(ctx context.Context, tx pgx.Tx, a domain.Actor) (domain.Counts, error) {
	var v domain.Counts
	e := tx.QueryRow(ctx, `SELECT count(*) FILTER(WHERE type='UPDATE_RECORD'),count(*) FILTER(WHERE type='OFFICIAL_MESSAGE'),count(*) FILTER(WHERE type='GENERATION'),count(*) FROM organization.notifications WHERE owner_id=$1 AND deleted_at IS NULL AND read_at IS NULL`, a.OwnerID).Scan(&v.UpdateRecords, &v.OfficialMessages, &v.Generations, &v.Total)
	return v, unavailable(e)
}
func (r *Repository) Unread(ctx context.Context, a domain.Actor) (domain.Counts, error) {
	var v domain.Counts
	e := r.within(ctx, true, func(tx pgx.Tx) error { var e error; v, e = unread(ctx, tx, a); return e })
	return v, e
}
func ownedNotifications(ctx context.Context, tx pgx.Tx, a domain.Actor, ids []string) error {
	rows, e := tx.Query(ctx, "SELECT id FROM organization.notifications WHERE owner_id=$1 AND id=ANY($2::text[]) AND deleted_at IS NULL ORDER BY id FOR UPDATE", a.OwnerID, ids)
	if e != nil {
		return unavailable(e)
	}
	defer rows.Close()
	count := 0
	for rows.Next() {
		var id string
		if rows.Scan(&id) != nil {
			return domain.ErrUnavailable
		}
		count++
	}
	if rows.Err() != nil {
		return domain.ErrUnavailable
	}
	if count != len(ids) {
		return domain.ErrNotFound
	}
	return nil
}
func (r *Repository) Read(ctx context.Context, a domain.Actor, ids []string, m application.Mutation) (domain.Counts, error) {
	var v domain.Counts
	e := r.within(ctx, false, func(tx pgx.Tx) error {
		if e := lock(ctx, tx, a, "inbox"); e != nil {
			return e
		}
		replayed, e := receipt(ctx, tx, a, "notification:read", m, &v)
		if e != nil || replayed {
			return e
		}
		if e = ownedNotifications(ctx, tx, a, ids); e != nil {
			return e
		}
		_, e = tx.Exec(ctx, "UPDATE organization.notifications SET read_at=now(),revision=revision+1 WHERE owner_id=$1 AND id=ANY($2::text[]) AND read_at IS NULL AND deleted_at IS NULL", a.OwnerID, ids)
		if e != nil {
			return unavailable(e)
		}
		v, e = unread(ctx, tx, a)
		if e != nil {
			return e
		}
		return saveReceipt(ctx, tx, a, "notification:read", m, 200, v)
	})
	return v, e
}
func (r *Repository) DeleteNotification(ctx context.Context, a domain.Actor, id string, m application.Mutation) (domain.NotificationDeletion, error) {
	var v domain.NotificationDeletion
	e := r.within(ctx, false, func(tx pgx.Tx) error {
		if e := lock(ctx, tx, a, "inbox"); e != nil {
			return e
		}
		replayed, e := receipt(ctx, tx, a, "notification:delete:"+id, m, &v)
		if e != nil || replayed {
			return e
		}
		if e = ownedNotifications(ctx, tx, a, []string{id}); e != nil {
			return e
		}
		n, e := notification(ctx, tx, a, id)
		if e != nil {
			return e
		}
		if n.Revision != m.Expected {
			return &domain.VersionConflict{Current: n.Revision}
		}
		v.ID = id
		e = tx.QueryRow(ctx, "UPDATE organization.notifications SET deleted_at=now(),revision=revision+1 WHERE id=$1 AND owner_id=$2 RETURNING revision,deleted_at", id, a.OwnerID).Scan(&v.Revision, &v.DeletedAt)
		if e != nil {
			return unavailable(e)
		}
		return saveReceipt(ctx, tx, a, "notification:delete:"+id, m, 200, v)
	})
	return v, e
}
func (r *Repository) DeleteNotifications(ctx context.Context, a domain.Actor, ids []string, m application.Mutation) (domain.BatchDeletion, error) {
	var v domain.BatchDeletion
	e := r.within(ctx, false, func(tx pgx.Tx) error {
		if e := lock(ctx, tx, a, "inbox"); e != nil {
			return e
		}
		replayed, e := receipt(ctx, tx, a, "notification:delete-batch", m, &v)
		if e != nil || replayed {
			return e
		}
		if e = ownedNotifications(ctx, tx, a, ids); e != nil {
			return e
		}
		_, e = tx.Exec(ctx, "UPDATE organization.notifications SET deleted_at=now(),revision=revision+1 WHERE owner_id=$1 AND id=ANY($2::text[]) AND deleted_at IS NULL", a.OwnerID, ids)
		if e != nil {
			return unavailable(e)
		}
		v.DeletedIDs = append([]string{}, ids...)
		v.Counts, e = unread(ctx, tx, a)
		if e != nil {
			return e
		}
		return saveReceipt(ctx, tx, a, "notification:delete-batch", m, 200, v)
	})
	return v, e
}
