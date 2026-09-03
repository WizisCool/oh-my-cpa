//go:build windows

package repository

import (
	"path/filepath"

	"golang.org/x/sys/windows"
)

func availableBytes(path string) (uint64, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return 0, err
	}
	var freeBytes uint64
	if err := windows.GetDiskFreeSpaceEx(windows.StringToUTF16Ptr(absolute), &freeBytes, nil, nil); err != nil {
		return 0, err
	}
	return freeBytes, nil
}
