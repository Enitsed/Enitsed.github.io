# enitsed.github.io

정슬기(SeulGi Jeong) — Backend · DevOps · Smart Contract Developer 포트폴리오 & 블로그.

## 개발

```bash
export PATH="/c/tools/ruby34/bin:$PATH"   # Windows Git Bash 기준
bundle install
bundle exec jekyll serve                   # http://localhost:4000
```

## 구조

- 프로젝트: `_data/projects.yml`
- 스킬/경력: `_data/skills.yml`, `_data/timeline.yml`
- 글: `_posts/YYYY-MM-DD-slug.md`
- 스타일: `assets/css/` (SCSS, 다크 테마 고정)

GitHub Pages가 `master` 브랜치를 자동 빌드·배포한다.
