package backup

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	appcrypto "github.com/oh-my-cpa/oh-my-cpa/internal/crypto"
	"github.com/oh-my-cpa/oh-my-cpa/internal/repository"
)

const CommandUsage = `Usage: oh-my-cpa database <export|inspect|restore|cancel|remote-list|fetch> [options]

Stop OMC before using this command. Export and restore use the configured target
database path and OMCPA_MASTER_KEY; inspection needs only the backup passphrase.
Passphrases are read from a private file, never command arguments.

  export  --output FILE --passphrase-file FILE
  inspect --file FILE --passphrase-file FILE
  restore --file FILE --passphrase-file FILE --confirm
  restore --rollback-id ID --confirm
  cancel
  remote-list --profile FILE --passphrase-file FILE [--destination ID]
  fetch --profile FILE --passphrase-file FILE --destination ID --object KEY --output FILE

Remote recovery does not need an existing database or deployment master key.
`

func RunCommand(ctx context.Context, databasePath, masterKey, version string, args []string, output io.Writer) error {
	if len(args) == 0 || args[0] == "--help" || args[0] == "-h" {
		_, err := io.WriteString(output, CommandUsage)
		return err
	}
	flags := flag.NewFlagSet("database "+args[0], flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	inputPath := flags.String("file", "", "backup file")
	outputPath := flags.String("output", "", "export file")
	passphrasePath := flags.String("passphrase-file", "", "passphrase file")
	rollbackID := flags.String("rollback-id", "", "restore rollback backup")
	isConfirmed := flags.Bool("confirm", false, "confirm whole-database replacement")
	profilePath := flags.String("profile", "", "encrypted recovery profile")
	destinationID := flags.String("destination", "", "destination ID in recovery profile")
	objectKey := flags.String("object", "", "backup object name")
	if err := flags.Parse(args[1:]); err != nil {
		return fmt.Errorf("%w\n%s", err, CommandUsage)
	}
	if flags.NArg() != 0 {
		return errors.New(CommandUsage)
	}
	if args[0] == "remote-list" || args[0] == "fetch" {
		if *profilePath == "" || *passphrasePath == "" {
			return errors.New(CommandUsage)
		}
		return runRemoteCommand(ctx, args[0], *profilePath, *destinationID, *objectKey, *outputPath, *passphrasePath, output)
	}
	if err := os.MkdirAll(filepath.Dir(databasePath), 0o700); err != nil {
		return err
	}
	lock, err := LockDatabase(databasePath)
	if err != nil {
		return err
	}
	defer lock.Close()
	if args[0] == "cancel" {
		if err := CancelPendingRestore(databasePath); err != nil {
			return err
		}
		_, err := fmt.Fprintln(output, "Pending database restoration cancelled")
		return err
	}
	var wrapping *appcrypto.Cipher
	if args[0] != "inspect" {
		wrapping, err = appcrypto.New(masterKey)
		if err != nil {
			return err
		}
	}
	passphrase := ""
	if *rollbackID != "" {
		if !validID(*rollbackID) || args[0] != "restore" || *inputPath != "" || *passphrasePath != "" {
			return errors.New(CommandUsage)
		}
		passphrase, err = wrapping.Fingerprint("omc-database-rollback-v1", *rollbackID)
		if err != nil {
			return err
		}
		*inputPath = filepath.Join(stateDirectory(databasePath), *rollbackID, "rollback.omcbackup")
	} else {
		if *passphrasePath == "" {
			return errors.New("--passphrase-file is required")
		}
		passphrase, err = readPassphraseFile(*passphrasePath)
		if err != nil {
			return err
		}
	}
	switch args[0] {
	case "export":
		cipher, err := ResolveCipher(databasePath, wrapping)
		if err != nil {
			return err
		}
		if *outputPath == "" || *inputPath != "" {
			return errors.New(CommandUsage)
		}
		temporary, err := os.MkdirTemp(filepath.Dir(databasePath), ".export-")
		if err != nil {
			return err
		}
		defer os.RemoveAll(temporary)
		snapshot := filepath.Join(temporary, "snapshot.db")

		if _, err := os.Stat(databasePath); err != nil {
			return err
		}
		id := newID()
		if err := repository.RecordStoppedDatabaseAudit(ctx, databasePath, repository.AuditEvent{Action: "system.database.export", TargetType: "database_backup", TargetID: id, Result: "admitted"}); err != nil {
			return fmt.Errorf("%w: %v", ErrAudit, err)
		}
		if err := repository.SnapshotStoppedDatabase(ctx, databasePath, snapshot); err != nil {
			return err
		}
		schema, err := repository.ValidateDatabaseBackup(ctx, snapshot)
		if err != nil {
			return err
		}
		if _, err := newCodec().pack(ctx, snapshot, *outputPath, passphrase, newManifest(id, version, schema), cipher); err != nil {
			return err
		}
		if err := repository.RecordStoppedDatabaseAudit(ctx, databasePath, repository.AuditEvent{Action: "system.database.export.completed", TargetType: "database_backup", TargetID: id, Result: "success"}); err != nil {
			return fmt.Errorf("backup was created, but outcome audit failed: %w", err)
		}
		_, err = fmt.Fprintln(output, "Encrypted database backup created")
		return err
	case "inspect":
		if *inputPath == "" {
			return errors.New(CommandUsage)
		}
		temporary, err := os.MkdirTemp(filepath.Dir(databasePath), ".inspect-")
		if err != nil {
			return err
		}
		defer os.RemoveAll(temporary)
		input, err := os.Open(*inputPath)
		if err != nil {
			return err
		}
		defer input.Close()
		candidate := filepath.Join(temporary, "candidate.db")
		manifest, _, err := newCodec().unpack(ctx, input, candidate, passphrase)
		if err != nil {
			return err
		}
		schema, err := repository.ValidateDatabaseBackup(ctx, candidate)
		if err != nil {
			return err
		}
		return json.NewEncoder(output).Encode(struct {
			Version       string `json:"omc_version"`
			SchemaVersion int    `json:"schema_version"`
			CreatedAtMS   int64  `json:"created_at_ms"`
			SizeBytes     int64  `json:"size_bytes"`
		}{manifest.Version, schema, manifest.CreatedAtMS, manifest.SizeBytes})
	case "restore":
		if !*isConfirmed || *inputPath == "" {
			return errors.New("restore requires --file and --confirm")
		}
		id, err := stageOfflineRestore(ctx, databasePath, *inputPath, passphrase, wrapping)
		if err != nil {
			return err
		}
		if err := ApplyPendingRestore(ctx, databasePath, wrapping, version); err != nil {
			return err
		}
		_, err = fmt.Fprintln(output, "Database restored:", id)
		return err
	default:
		return errors.New(CommandUsage)
	}
}

func readPassphraseFile(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	info, err := file.Stat()
	if err != nil {
		file.Close()
		return "", err
	}
	if !info.Mode().IsRegular() || info.Size() > 1026 || (runtime.GOOS != "windows" && info.Mode().Perm()&0o077 != 0) {
		file.Close()
		return "", errors.New("passphrase file must be private and regular")
	}
	content, readErr := io.ReadAll(io.LimitReader(file, 1027))
	if err := errors.Join(readErr, file.Close()); err != nil {
		return "", err
	}
	passphrase := strings.TrimSuffix(strings.TrimSuffix(string(content), "\n"), "\r")
	return passphrase, validatePassphrase(passphrase)
}
