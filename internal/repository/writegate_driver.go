package repository

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"errors"
	"strings"
	"sync"

	sqlitedriver "modernc.org/sqlite"
)

// gatedDriverName is the driver this package registers for its own use. It is
// deliberately not "sqlite": registering the application pool under the plain name
// would change the behaviour of every unrelated opener in the process, including the
// in-memory databases tests and integrations open directly.
const gatedDriverName = "sqlite-gated"

var registerGatedDriverOnce sync.Once

// registerGatedDriver registers the gated driver exactly once per process; a second
// registration under the same name panics, and the pool is opened more than once across
// tests.
//
// The registered driver carries no gate of its own. Each pool gets its own through
// `gatedConnector`, because a process-wide gate would make one database's rebuild block
// writes to every other database in the process - which in this repository means a test
// that holds a maintenance job could stall an unrelated test's writes, and in production
// would serialize two databases that have nothing to do with each other.
func registerGatedDriver() {
	registerGatedDriverOnce.Do(func() {
		sql.Register(gatedDriverName, &rejectingDriver{})
	})
}

// rejectingDriver refuses direct opens. Every real open goes through gatedConnector, so a
// connection without a gate cannot be created by accident: an `sql.Open(gatedDriverName,
// dsn)` that bypassed the connector would otherwise hand back an ungated pool under a
// name that promises the opposite.
type rejectingDriver struct{}

func (d *rejectingDriver) Open(string) (driver.Conn, error) {
	return nil, errors.New("open this driver through repository.Open so it carries a write gate")
}

// gatedConnector hands out connections bound to one gate, and it is the only supported
// way to open a pool for this application.
type gatedConnector struct {
	inner driver.Driver
	gate  *writeGate
	dsn   string
}

func (c gatedConnector) Connect(context.Context) (driver.Conn, error) {
	conn, err := c.inner.Open(c.dsn)
	if err != nil {
		return nil, err
	}
	return &gatedConn{inner: conn, gate: c.gate}, nil
}

func (c gatedConnector) Driver() driver.Driver { return c.inner }

// openGatedPool opens a pool over the given DSN, sharing one gate with every other pool
// opened with the same gate.
func openGatedPool(dsn string, gate *writeGate) *sql.DB {
	return sql.OpenDB(gatedConnector{inner: &sqlitedriver.Driver{}, gate: gate, dsn: dsn})
}

// gatedDSN appends the connection pragmas the driver applies itself.
//
// They stay in the DSN rather than becoming statements issued through the pool because
// modernc.org/sqlite applies them inside the driver, below the gate. That distinction is
// load-bearing: the set includes `journal_mode(WAL)`, which the classifier treats as a
// write, so routing it through the pool during connection setup would make the first
// connection of a restart wait on a maintenance job before the database was even usable.
func gatedDSN(databasePath string) string {
	separator := "?"
	if strings.Contains(databasePath, "?") {
		separator = "&"
	}
	return databasePath + separator + "_pragma=busy_timeout(5000)&_pragma=foreign_keys(1)&_pragma=journal_mode(WAL)&_pragma=synchronous(NORMAL)"
}

func (db *DB) driverName() string {
	if db == nil {
		return ""
	}
	// database/sql does not expose the driver name, so it is recorded at open time. This
	// accessor exists for the wiring test, which fails closed if the pool was opened
	// without a gate.
	return db.driver
}
