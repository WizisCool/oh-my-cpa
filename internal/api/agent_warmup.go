package api

import (
	"context"

	"github.com/oh-my-cpa/oh-my-cpa/internal/operations"
	"github.com/oh-my-cpa/oh-my-cpa/internal/warmup"
)

func (handler *Handler) bindWarmupOperations(service *operations.Service) {
	service.WarmupSettings = handler.warmupSettings
	service.SaveWarmupSettings = handler.saveWarmupSettings
	service.SaveWarmupCredential = handler.saveWarmupCredential
	service.RunWarmup = func(ctx context.Context, authIndex, requestID, revision string) (warmup.Result, error) {
		return handler.executeWarmup(ctx, authIndex, requestID, revision, true)
	}
	service.WarmupCredential = func(ctx context.Context, authIndex string) (warmup.Credential, error) {
		client, err := handler.capabilityClient(ctx)
		if err != nil {
			return warmup.Credential{}, err
		}
		file, err := handler.warmupFile(ctx, client, authIndex)
		if err != nil {
			return warmup.Credential{}, err
		}
		return handler.warmupCredential(ctx, client, file, true)
	}
}
