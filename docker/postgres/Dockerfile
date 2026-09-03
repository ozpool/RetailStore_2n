# syntax=docker/dockerfile:1

# Postgres, plus the one binary needed to archive write-ahead log segments to
# object storage.
#
# WHY A CUSTOM IMAGE AT ALL
# `archive_command` is a shell command Postgres runs for every completed WAL
# segment, and it has to put that segment somewhere durable and off this
# machine. The official image has no S3 client, so there is nothing to run.
#
# WHY `mc` AND NOT pgBackRest, WAL-G, OR barman
# All three are better tools and all three want a package manager, a config
# file, and a service of their own. `mc` is a single static binary copied from
# the image that already bootstraps the bucket, so the whole addition is two
# lines and no new failure mode.
#
# It is also honest about the ceiling: `mc cp` gives WAL archiving and
# point-in-time recovery, and none of the incremental backup, parallel restore,
# retention policy or verification that pgBackRest does. In Kubernetes this is
# replaced by CloudNativePG's `barmanObjectStore`, which is barman doing the job
# properly — see docs/adr/0020-replication-and-backups.md
FROM postgres:16-alpine

# One binary, no package manager, no Python. The same client
# docker/minio/minio-init.sh uses, so there is one S3 tool in this stack rather
# than two.
COPY --from=minio/mc:latest /usr/bin/mc /usr/local/bin/mc

# mc is configured entirely by MC_HOST_<alias> in the environment, so there is
# no config file to write and no credentials baked into the image. Set in
# docker-compose.yml. Proved here so a missing binary fails the build rather
# than every archive_command at runtime.
RUN mc --version > /dev/null && echo "mc available for archive_command"
