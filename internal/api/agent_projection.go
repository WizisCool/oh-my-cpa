package api

import "github.com/oh-my-cpa/oh-my-cpa/internal/agent"

// The console needs the transcript, not the model's private history. An explicit turn DTO keeps
// query rows out of session reads and snapshots even when older stored sessions contain them.
type agentTurnDTO struct {
	ID            string        `json:"id"`
	User          string        `json:"user"`
	Reply         string        `json:"reply"`
	Parts         []agent.Part  `json:"parts,omitempty"`
	Status        string        `json:"status"`
	Code          string        `json:"code,omitempty"`
	Traces        []agent.Trace `json:"traces"`
	Rounds        int           `json:"rounds"`
	Calls         int           `json:"calls"`
	StartedMS     int64         `json:"started_at_ms,omitempty"`
	EndedMS       int64         `json:"ended_at_ms,omitempty"`
	Usage         *agent.Usage  `json:"usage,omitempty"`
	PromptVersion string        `json:"prompt_version,omitempty"`
}

type agentConversationDTO struct {
	ActiveRunID     string         `json:"active_run_id,omitempty"`
	ID              string         `json:"id"`
	Revision        int64          `json:"revision"`
	Fingerprint     string         `json:"client_key_fingerprint"`
	Model           string         `json:"model"`
	ReasoningEffort string         `json:"reasoning_effort,omitempty"`
	Turns           []agentTurnDTO `json:"turns"`
	Omitted         int            `json:"omitted"`
	AnchorMS        int64          `json:"anchor_ms"`
}

func agentTraceForConsole(trace agent.Trace) agent.Trace {
	if trace.Name == "database_query" {
		trace.Result.Data = nil
		trace.View = nil
	}
	return trace
}

func agentConversationForConsole(conversation *agent.Conversation) *agentConversationDTO {
	if conversation == nil {
		return nil
	}
	turns := make([]agentTurnDTO, len(conversation.Turns))
	for i, turn := range conversation.Turns {
		traces := make([]agent.Trace, len(turn.Traces))
		for j, trace := range turn.Traces {
			traces[j] = agentTraceForConsole(trace)
		}
		turns[i] = agentTurnDTO{
			ID: turn.ID, User: turn.User, Reply: turn.Reply, Parts: turn.Parts,
			Status: turn.Status, Code: turn.Code, Traces: traces, Rounds: turn.Rounds,
			Calls: turn.Calls, StartedMS: turn.StartedMS, EndedMS: turn.EndedMS,
			Usage: turn.Usage, PromptVersion: turn.PromptVersion,
		}
	}
	return &agentConversationDTO{
		ID: conversation.ID, Revision: conversation.Revision, Fingerprint: conversation.Fingerprint,
		Model: conversation.Model, ReasoningEffort: conversation.ReasoningEffort, Turns: turns,
		Omitted: conversation.Omitted, AnchorMS: conversation.AnchorMS,
	}
}
