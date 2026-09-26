#!/usr/bin/env bash
# 幂等地准备本地开发用 Postgres 16：容器 orgos-postgres，宿主端口 5470 → 容器 5432。
# 用户/密码 orgos；确保开发库 orgos 与测试库 orgos_test 都存在。重复执行无副作用。
set -euo pipefail

CONTAINER_NAME="orgos-postgres"
PG_PORT="5470"
PG_USER="orgos"
PG_PASSWORD="orgos"
DATABASES=("orgos" "orgos_test")

if docker inspect "${CONTAINER_NAME}" >/dev/null 2>&1; then
	STATE="$(docker inspect -f '{{.State.Status}}' "${CONTAINER_NAME}")"
	if [[ "${STATE}" != "running" ]]; then
		echo "[dev-db] 容器 ${CONTAINER_NAME} 处于 ${STATE}，正在启动..."
		docker start "${CONTAINER_NAME}" >/dev/null
	else
		echo "[dev-db] 容器 ${CONTAINER_NAME} 已在运行。"
	fi
else
	echo "[dev-db] 创建并启动 ${CONTAINER_NAME}（postgres:16，端口 ${PG_PORT}）..."
	docker run -d \
		--name "${CONTAINER_NAME}" \
		-e POSTGRES_USER="${PG_USER}" \
		-e POSTGRES_PASSWORD="${PG_PASSWORD}" \
		-e POSTGRES_DB="${DATABASES[0]}" \
		-p "127.0.0.1:${PG_PORT}:5432" \
		-v orgos_pg_data:/var/lib/postgresql/data \
		--restart=on-failure \
		postgres:16 >/dev/null
fi

READY=0
for _ in $(seq 1 30); do
	# 连 TCP 而不是 unix socket：初始化阶段的临时服务只听 socket，此时判为就绪会撞上随后的重启。
	if docker exec "${CONTAINER_NAME}" pg_isready -h 127.0.0.1 -U "${PG_USER}" -d postgres >/dev/null 2>&1; then
		READY=1
		break
	fi
	sleep 1
done
if [[ "${READY}" != "1" ]]; then
	echo "[dev-db] 超时：Postgres 30s 内未就绪。" >&2
	exit 1
fi

for DB in "${DATABASES[@]}"; do
	EXISTS="$(docker exec "${CONTAINER_NAME}" psql -h 127.0.0.1 -U "${PG_USER}" -d postgres -tAc "select 1 from pg_database where datname = '${DB}'")"
	if [[ "${EXISTS}" != "1" ]]; then
		docker exec "${CONTAINER_NAME}" createdb -h 127.0.0.1 -U "${PG_USER}" "${DB}"
		echo "[dev-db] 已创建数据库 ${DB}。"
	fi
done

echo "[dev-db] 就绪：postgresql://${PG_USER}:${PG_PASSWORD}@127.0.0.1:${PG_PORT}/{orgos,orgos_test}"
