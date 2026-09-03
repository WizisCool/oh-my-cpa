//go:build !windows

package repository

import (
	"path/filepath"
	"syscall"
)

func availableBytes(path string) (uint64, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return 0, err
	}
	var stat syscall.Statfs_t
	if err := syscall.Statfs(absolute, &stat); err != nil {
		return 0, err
	}
	return uint64(stat.Bavail) * uint64(stat.Bsize), nil
}
