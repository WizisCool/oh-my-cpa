//go:build !windows

package backup

import (
	"errors"
	"os"

	"golang.org/x/sys/unix"
)

type DataLock struct{ file *os.File }

func LockDatabase(path string) (*DataLock, error) {
	file, err := os.OpenFile(path+".lock", os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, err
	}
	if err := unix.Flock(int(file.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != nil {
		file.Close()
		return nil, errors.New("database is already in use by another OMC process")
	}
	return &DataLock{file}, nil
}
func (lock *DataLock) Close() error {
	if lock == nil {
		return nil
	}
	return lock.file.Close()
}
func syncDirectory(path string) error {
	directory, err := os.Open(path)
	if err != nil {
		return err
	}
	defer directory.Close()
	return directory.Sync()
}
