var gulp = require('gulp');
var sass = require('gulp-sass');
var prefix = require('gulp-autoprefixer');
var imagemin = require('gulp-imagemin');
var pngquant = require('imagemin-pngquant');
var cache = require('gulp-cache');
var cp = require('child_process');
var browserSync = require('browser-sync').create();

var jekyll   = process.platform === 'win32' ? 'jekyll.bat' : 'jekyll';

// Build the Jekyll Site
gulp.task('jekyll-build', gulp.series(function (done) {
    return cp.spawn( jekyll , ['build'], {stdio: 'inherit'}).on('close', done);
}));

// Rebuild Jekyll and page reload
gulp.task('jekyll-rebuild', gulp.series('jekyll-build', function () {
    browserSync.reload();
}));

// Compile files
gulp.task('sass', gulp.series(function () {
    return gulp.src('assets/css/sass/main.sass')
        .pipe(sass({
            outputStyle: 'expanded',
            onError: browserSync.notify
        }))
        .pipe(prefix(['last 15 versions', '> 1%', 'ie 8', 'ie 7'], { cascade: true }))
        .pipe(gulp.dest('_site/assets/css'))
        .pipe(browserSync.reload({stream:true}))
        .pipe(gulp.dest('assets/css'));
}));

// Compression images
gulp.task('img', gulp.series(function() {
	return gulp.src('assets/img/**/*')
		.pipe(cache(imagemin({
			interlaced: true,
			progressive: true,
			svgoPlugins: [{removeViewBox: false}],
			use: [pngquant()]
		})))
    .pipe(gulp.dest('_site/assets/img'))
    .pipe(browserSync.reload({stream:true}));
}));

// Fonts
gulp.task('fonts', gulp.series(function() {
    return gulp.src('assets/fonts/**/*')
        .pipe(gulp.dest('_site/assets/fonts'))
        .pipe(browserSync.reload({stream:true}));
}));

// Wait for jekyll-build, then launch the Server
gulp.task('browser-sync', gulp.series('sass', 'img', 'fonts', 'jekyll-build'), function() {
    browserSync.init({
        server: {
            baseDir: '_site'
        },
        notify: true,
        watch: true
    });
});

// Watch scss, html, img files
gulp.task('watch', gulp.series(function () {
    gulp.watch('assets/css/sass/*.*', gulp.series('sass'));
    gulp.watch('assets/js/**/*.js', gulp.series('jekyll-rebuild'));
    gulp.watch('assets/img/**/*', gulp.series('img'));
    gulp.watch('assets/fonts/**/*', gulp.series('fonts'));
    gulp.watch(['*.html', '_layouts/*.html', '_includes/*.html', '_pages/*.html', '_posts/*'], gulp.series('jekyll-rebuild'));
}));

//  Default task
gulp.task('default', gulp.series('browser-sync', 'watch'));
