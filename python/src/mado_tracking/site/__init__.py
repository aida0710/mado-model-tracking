"""Sites: computers added on the Web whose Jobs a job shell submits (ComputeTarget.executor='site').

A site's connection, job shell and each person's account settings live in tracking. A launcher
logs in with keys it makes itself and runs the site's job shell with a spec directory; where
logins need a one-time password, or the site is a researcher's PC, the person runs
`mado-tracking submit` there instead. The runner on the compute node then reports to the API
itself with the Job token (docs/sites.md).
"""
