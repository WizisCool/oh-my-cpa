package config

import (
	"bufio"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
)

// DefaultDotEnvFile is the file LoadDotEnv reads when no explicit path is
// given. It lives next to the process working directory so a developer can
// keep local CPA endpoints, keys and passwords out of the shell.
const DefaultDotEnvFile = ".env"

// DotEnvPath returns the dotenv file this process should load. OMCPA_ENV_FILE
// overrides the default so CI or a second instance can point elsewhere.
func DotEnvPath() string {
	if value := strings.TrimSpace(os.Getenv("OMCPA_ENV_FILE")); value != "" {
		return value
	}
	return DefaultDotEnvFile
}

// LoadDotEnv applies KEY=VALUE pairs from path to the process environment.
//
// Real environment variables always win: the file only fills gaps. That keeps
// container/CI injection working while still allowing `go run ./cmd/oh-my-cpa`
// to pick up a local debug file. A missing file is not an error; the number of
// applied variables is returned so callers can log that the file was read.
// Values are never logged by this package because they hold credentials.
func LoadDotEnv(path string) (int, error) {
	file, err := os.Open(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return 0, nil
		}
		return 0, fmt.Errorf("open %s: %w", path, err)
	}
	defer file.Close()

	applied := 0
	scanner := bufio.NewScanner(file)
	scanner.Buffer(make([]byte, 0, 4096), 64*1024)
	lineNumber := 0
	for scanner.Scan() {
		lineNumber++
		key, value, ok, err := parseDotEnvLine(scanner.Text())
		if err != nil {
			return applied, fmt.Errorf("%s line %d: %w", path, lineNumber, err)
		}
		if !ok {
			continue
		}
		if _, exists := os.LookupEnv(key); exists {
			continue
		}
		if err := os.Setenv(key, value); err != nil {
			return applied, fmt.Errorf("set %s: %w", key, err)
		}
		applied++
	}
	if err := scanner.Err(); err != nil && !errors.Is(err, io.EOF) {
		return applied, fmt.Errorf("read %s: %w", path, err)
	}
	return applied, nil
}

// parseDotEnvLine understands the subset of dotenv syntax that is useful for
// local debugging: blank lines, `#` comment lines, an optional `export`
// prefix, single or double quoted values, and inline comments after an
// unquoted value. A `#` inside a quoted value stays part of the value.
func parseDotEnvLine(raw string) (key string, value string, ok bool, err error) {
	line := strings.TrimSpace(raw)
	if line == "" || strings.HasPrefix(line, "#") {
		return "", "", false, nil
	}
	line = strings.TrimPrefix(line, "export ")
	name, rest, found := strings.Cut(line, "=")
	if !found {
		return "", "", false, errors.New("expected KEY=VALUE")
	}
	key = strings.TrimSpace(name)
	if key == "" || strings.ContainsAny(key, " \t\"'") {
		return "", "", false, fmt.Errorf("invalid variable name %q", name)
	}
	value = strings.TrimSpace(rest)
	if value == "" {
		return key, "", true, nil
	}
	if quote := value[0]; quote == '\'' || quote == '"' {
		end := strings.IndexByte(value[1:], quote)
		if end < 0 {
			return "", "", false, fmt.Errorf("unterminated quoted value for %s", key)
		}
		return key, value[1 : 1+end], true, nil
	}
	if index := strings.IndexByte(value, '#'); index >= 0 {
		value = strings.TrimSpace(value[:index])
	}
	return key, value, true, nil
}
