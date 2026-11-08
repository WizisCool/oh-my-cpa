package api

import (
	"context"

	"github.com/oh-my-cpa/oh-my-cpa/internal/operations"
	"github.com/oh-my-cpa/oh-my-cpa/internal/warmup"
)

func (h *Handler) bindWarmupOperations(service *operations.Service) {
	service.WarmupSettings = h.warmupState
	service.SaveWarmupTask = func(ctx context.Context, input warmup.TaskSaveInput) (warmup.StateView, error) {
		return h.saveWarmupTask(ctx, input.ID, input.TaskInput)
	}
	service.DeleteWarmupTask = h.removeWarmupTask
	service.RunWarmupTask = h.triggerWarmupTask
}
