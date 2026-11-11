package application

import (
	"math"
	"reflect"

	"studiotv.local/service/api/internal/modules/execution/domain"
	gateway "studiotv.local/service/api/internal/modules/modelgateway/application"
)

func observePlanProgress(plan *domain.Plan, invocation gateway.Invocation) bool {
	var value *float64
	if invocation.Progress != nil && !math.IsNaN(*invocation.Progress) && !math.IsInf(*invocation.Progress, 0) && *invocation.Progress >= 0 && *invocation.Progress <= 1 {
		copy := *invocation.Progress
		value = &copy
	}
	var detail *domain.ProgressDetail
	if source := invocation.ProgressDetail; source != nil {
		detail = &domain.ProgressDetail{Phase: source.Phase, Scope: source.Scope, CurrentStep: source.CurrentStep, TotalSteps: source.TotalSteps}
	}
	if reflect.DeepEqual(plan.Progress, value) && reflect.DeepEqual(plan.ProgressDetail, detail) {
		return false
	}
	plan.Progress, plan.ProgressDetail = value, detail
	return true
}

func completePlanProgress(plan *domain.Plan) {
	complete := 1.0
	plan.Progress = &complete
	plan.ProgressDetail = &domain.ProgressDetail{Phase: "completed", Scope: "TASK"}
}
