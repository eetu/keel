/**
 * How far a cap has to sit above the measurement behind it.
 *
 * A cap close to the workload fires in normal operation; far above it, nothing
 * fires and the board runs out of memory first. Both ends move together when the
 * fleet is re-measured, which is why the pair lives here rather than in each test
 * that holds an entry to it: a second copy would keep passing against a rule the
 * real invariant no longer states.
 */
export const CAP_HEADROOM = { min: 1.5, max: 8 };
