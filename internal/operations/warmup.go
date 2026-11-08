package operations

import (
	"context"
	"errors"
	"strings"

	"github.com/oh-my-cpa/oh-my-cpa/internal/capability"
	"github.com/oh-my-cpa/oh-my-cpa/internal/warmup"
)

func (service *Service) registerWarmup(registry *capability.Registry) error {
	if err := read(registry, "quota_warmup_settings_get", "Read window warmup tasks, recent runs, upcoming timeline and credential catalog.", func(ctx context.Context, _ Empty) (warmup.StateView, error) {
		return service.WarmupSettings(ctx)
	}); err != nil {
		return err
	}
	metadata := Meta("quota_warmup_task_save", "Create or update a credential window warmup task. Requires confirmation; enabled tasks send minimal inference probes through CPA on schedule.", "write", "high")
	if err := capability.Register(registry, metadata,
		func(_ context.Context, input warmup.TaskSaveInput) (capability.Preview, error) {
			if service.NormalizeWarmupTask == nil {
				return capability.Preview{}, errors.New("capability_unavailable")
			}
			// The save fills in what a caller may leave out, so the preview checks and shows that.
			input.TaskInput = service.NormalizeWarmupTask(input.TaskInput)
			if err := warmup.ValidateTask(input.TaskInput); err != nil {
				return capability.Preview{}, invalidParameters{detail: err.Error()}
			}
			target := strings.TrimSpace(input.ID)
			if target == "" {
				target = warmup.DefaultTaskName(input.TaskInput)
			}
			return capability.Preview{Target: target, Revision: service.revision(input), Changes: input}, nil
		},
		func(ctx context.Context, input warmup.TaskSaveInput, _, _ string) (warmup.StateView, error) {
			return service.SaveWarmupTask(ctx, input)
		},
	); err != nil {
		return err
	}
	metadata = Meta("quota_warmup_task_delete", "Delete a credential window warmup task.", "destructive", "high")
	if err := capability.Register(registry, metadata,
		func(_ context.Context, input warmup.TaskIDInput) (capability.Preview, error) {
			id := strings.TrimSpace(input.ID)
			if id == "" {
				return capability.Preview{}, invalidParameters{detail: "id is required"}
			}
			return capability.Preview{Target: id, Revision: service.revision(id), Changes: map[string]string{"id": id}}, nil
		},
		func(ctx context.Context, input warmup.TaskIDInput, _, _ string) (warmup.StateView, error) {
			return service.DeleteWarmupTask(ctx, strings.TrimSpace(input.ID))
		},
	); err != nil {
		return err
	}
	metadata = Meta("quota_warmup_run", "Trigger one warmup task immediately through CPA's credential-pinned verification endpoint. Requires confirmation.", "write", "high")
	return capability.Register(registry, metadata,
		func(_ context.Context, input warmup.TaskIDInput) (capability.Preview, error) {
			id := strings.TrimSpace(input.ID)
			if id == "" {
				return capability.Preview{}, invalidParameters{detail: "id is required"}
			}
			return capability.Preview{Target: id, Revision: service.revision(id), Changes: map[string]string{"id": id}}, nil
		},
		func(ctx context.Context, input warmup.TaskIDInput, _, _ string) (warmup.RunResponse, error) {
			return service.RunWarmupTask(ctx, strings.TrimSpace(input.ID))
		},
	)
}
