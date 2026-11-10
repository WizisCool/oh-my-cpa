package updater

import (
	"context"
	"fmt"
	"net"
	"slices"
	"sort"
	"strings"
)

// connectProxyNetwork temporarily joins the network on which the console reaches a local proxy container.
// It returns only attachments made by this job, so existing network membership is preserved.
func (s *Service) connectProxyNetwork(ctx context.Context, proxyURL string) (string, error) {
	proxy, err := ParseImagePullProxy(proxyURL)
	if err != nil {
		return "", err
	}

	// IP addresses and ordinary external hosts use the updater's existing egress route.
	host := proxy.Hostname()
	if s.options.SelfID == "" || net.ParseIP(host) != nil || strings.EqualFold(host, "localhost") {
		return "", nil
	}

	engine := s.options.Engine
	self, err := engine.InspectContainer(ctx, s.options.SelfID)
	if err != nil {
		return "", fmt.Errorf("inspect the updater's proxy route: %w", err)
	}

	// Shared and host namespaces use their owner's routing rather than independent network attachments.
	mode := stringField(self.HostConfig, "NetworkMode")
	if mode == "host" || strings.HasPrefix(mode, "container:") {
		return "", nil
	}

	console, err := s.resolveOMC(ctx)
	if err != nil {
		return "", err
	}

	containers, err := engine.ListContainers(ctx)
	if err != nil {
		return "", fmt.Errorf("discover the proxy container: %w", err)
	}

	// Only consider proxy aliases on a network the console already uses, avoiding unrelated deployments.
	networks := map[string]bool{}
	for _, summary := range containers {
		if summary.State != "running" {
			continue
		}

		candidate, err := engine.InspectContainer(ctx, summary.ID)
		if err != nil {
			return "", fmt.Errorf("inspect the proxy container: %w", err)
		}

		if !answersTo(candidate, host) {
			continue
		}

		for network, endpoint := range candidate.NetworkSettings.Networks {
			if _, shared := console.NetworkSettings.Networks[network]; !shared {
				continue
			}

			if candidate.ContainerName() != host && !slices.Contains(stringList(endpoint["Aliases"]), host) {
				continue
			}

			if _, attached := self.NetworkSettings.Networks[network]; attached {
				return "", nil
			}

			networks[network] = true
		}
	}

	if len(networks) == 0 {
		return "", nil
	}

	// Pick a stable shared network; the attachment is removed before container replacement or handover.
	names := make([]string, 0, len(networks))
	for network := range networks {
		names = append(names, network)
	}
	sort.Strings(names)
	network := names[0]
	if err := engine.ConnectNetwork(ctx, network, s.options.SelfID, nil); err != nil {
		return "", fmt.Errorf("join the proxy's shared network: %w", err)
	}

	return network, nil
}
