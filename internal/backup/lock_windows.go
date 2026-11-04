package backup

import (
	"errors"
	"os"

	"golang.org/x/sys/windows"
)

type DataLock struct {
	file       *os.File
	overlapped windows.Overlapped
}

func LockDatabase(path string) (*DataLock, error) {
	file, err := os.OpenFile(path+".lock", os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	lock := &DataLock{file: file}
	if err := windows.LockFileEx(windows.Handle(file.Fd()), windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, &lock.overlapped); err != nil {
		file.Close()
		return nil, errors.New("database is already in use by another OMC process")
	}
	return lock, nil
}
func (lock *DataLock) Close() error {
	if lock == nil {
		return nil
	}
	return lock.file.Close()
}

// Windows commits file contents before publication; unlike Unix it does not
// expose a portable directory-fsync operation through os.File.
func syncDirectory(string) error { return nil }
