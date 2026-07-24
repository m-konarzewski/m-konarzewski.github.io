HUGO ?= hugo

.PHONY: build serve deploy

build:
	$(HUGO) --gc --minify

serve:
	$(HUGO) server -D

deploy:
	./scripts/deploy.sh
