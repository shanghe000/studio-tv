package postgres_test

import (
	"github.com/google/uuid"
	"testing"
)

func TestPostgresSharedCanvasConversationsStayPersonal(t *testing.T) {
	pool, ctx := isolatedDatabase(t)
	if _, e := pool.Exec(ctx, `INSERT INTO public.users(id,email,display_name) VALUES('owner-a','a@example.test','A'),('owner-b','b@example.test','B');INSERT INTO public.projects(id,owner_id,name) VALUES('project-a','owner-a','A');INSERT INTO collaboration.project_members(project_id,user_id,role,created_by) VALUES('project-a','owner-b','EDITOR','owner-a')`); e != nil {
		t.Fatal(e)
	}
	router := integrationRouter(t, pool)
	created := call(router, "POST", "/api/v2/conversations", "owner-b", `{"kind":"CANVAS","projectId":"project-a","title":"Shared project private assistant"}`, map[string]string{"Idempotency-Key": uuid.NewString()})
	assertStatus(t, created, 201)
	cid := object(created)["id"].(string)
	assertStatus(t, call(router, "GET", "/api/v2/conversations/"+cid, "owner-a", "", nil), 404)
	assertStatus(t, call(router, "GET", "/api/v2/conversations/"+cid, "owner-b", "", nil), 200)
	if _, e := pool.Exec(ctx, `UPDATE collaboration.project_members SET role='VIEWER' WHERE project_id='project-a' AND user_id='owner-b'`); e != nil {
		t.Fatal(e)
	}
	assertStatus(t, call(router, "POST", "/api/v2/conversations", "owner-b", `{"kind":"CANVAS","projectId":"project-a","title":"Viewer cannot create"}`, map[string]string{"Idempotency-Key": uuid.NewString()}), 403)
	if _, e := pool.Exec(ctx, `DELETE FROM collaboration.project_members WHERE project_id='project-a' AND user_id='owner-b'`); e != nil {
		t.Fatal(e)
	}
	assertStatus(t, call(router, "GET", "/api/v2/conversations/"+cid, "owner-b", "", nil), 404)
}
