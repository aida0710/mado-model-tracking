"""Sites: computers tracking only describes (ComputeTarget.executor='site').

A launcher, or the requester with `mado-tracking submit` where logins need a one-time password,
runs the site's job shell with a spec directory. The runner on the compute node then reports to
the API itself with the Job token (docs/design/external-execution.md).
"""
