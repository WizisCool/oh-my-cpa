package operations

import (
	"context"
	"errors"
	"strconv"

	"github.com/oh-my-cpa/oh-my-cpa/internal/capability"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

type CustomIconTarget struct {
	ID string `json:"id"`
}

func (s *Service) registerCustomIcons(registry *capability.Registry) error {
	type PageInput struct {
		Offset int `json:"offset,omitempty"`
	}
	type Page struct {
		Icons   []repository.CustomIcon `json:"icons"`
		HasMore bool                    `json:"has_more"`
	}
	if err := read(registry, "custom_icons_list", "List saved custom icon metadata and reference counts, twenty per page; artwork bytes are not returned.", func(ctx context.Context, input PageInput) (Page, error) {
		icons, err := s.Repo.ListCustomIcons(ctx)
		if err != nil {
			return Page{}, err
		}
		if input.Offset < 0 || input.Offset > len(icons) {
			return Page{}, errors.New("invalid_parameters")
		}
		end := min(input.Offset+20, len(icons))
		return Page{Icons: icons[input.Offset:end], HasMore: end < len(icons)}, nil
	}); err != nil {
		return err
	}
	type CreateInput struct {
		Name string `json:"name"`
		Data string `json:"data" jsonschema:"Static image Base64 or image data URL; capability input is limited to 32 KiB. Use the browser picker for larger artwork."`
	}
	metadata := Meta("custom_icon_create", "Save a named static custom icon from Base64. Does not assign it to a provider.", "write", "low")
	metadata.Invalidates = []string{"custom-icons"}
	if err := capability.Register(registry, metadata, nil, func(ctx context.Context, input CreateInput, _, _ string) (repository.CustomIcon, error) {
		return s.Repo.CreateCustomIcon(ctx, input.Name, input.Data)
	}); err != nil {
		return err
	}
	type UpdateInput struct {
		ID   string  `json:"id"`
		Name *string `json:"name,omitempty"`
		Data *string `json:"data,omitempty"`
	}
	metadata = Meta("custom_icon_update", "Rename or replace a saved custom icon. Replacement updates every provider reference.", "write", "low")
	metadata.Invalidates = []string{"custom-icons"}
	if err := capability.Register(registry, metadata, nil, func(ctx context.Context, input UpdateInput, _, _ string) (repository.CustomIcon, error) {
		return s.Repo.UpdateCustomIcon(ctx, input.ID, input.Name, input.Data)
	}); err != nil {
		return err
	}
	metadata = Meta("custom_icon_delete", "Delete a custom icon and clear all provider assignments to it, restoring their default artwork.", "destructive", "high")
	metadata.Invalidates = []string{"custom-icons", "preferences"}
	return capability.Register(registry, metadata, func(ctx context.Context, input CustomIconTarget) (capability.Preview, error) {
		icon, err := s.Repo.GetCustomIcon(ctx, input.ID)
		if err != nil {
			return capability.Preview{}, err
		}
		icons, err := s.Repo.ListCustomIcons(ctx)
		if err != nil {
			return capability.Preview{}, err
		}
		for _, listed := range icons {
			if listed.ID == icon.ID {
				icon.ReferenceCount = listed.ReferenceCount
			}
		}
		return capability.Preview{Target: icon.ID, Revision: strconv.FormatInt(icon.Revision, 10), Changes: map[string]string{"name": icon.Name, "reference_count": strconv.Itoa(icon.ReferenceCount), "provider_icons": "restore_defaults"}}, nil
	}, func(ctx context.Context, input CustomIconTarget, revision, _ string) (Done, error) {
		expected, err := strconv.ParseInt(revision, 10, 64)
		if err != nil {
			return Done{}, errors.New("resource_conflict")
		}
		err = s.Repo.DeleteCustomIconChecked(ctx, input.ID, expected)
		return Done{IsUpdated: err == nil}, err
	})
}
