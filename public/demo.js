/**
 * Created by dusanklinec on 06.04.16.
 * Common JS methods for all demos
 */

function set_request(msg){
    $("#reqRest").html(msg);
}

function display_message(msg) {
    $("#status").html(msg);
}

function formatDate(date) {
    var hours = date.getHours();
    var minutes = date.getMinutes();
    var sec = date.getSeconds();
    var milli = date.getMilliseconds();
    var strTime = sprintf("%02d:%02d:%02d.%03d", hours, minutes, sec, milli);
    return date.getMonth()+1 + "/" + date.getDate() + "/" + date.getFullYear() + " " + strTime;
}

function append_message(msg) {
    var status = $("#status");
    var newMsg = formatDate(new Date()) + " - " + he.encode(msg);
    status.html(status.html() + "<br/>\n" + newMsg);
}

function successBg(x, success){
    if (success === undefined){
        x.removeClass('successBg');
        x.removeClass('failedBg');
    } else if (success){
        x.addClass('successBg');
        x.removeClass('failedBg');
    } else {
        x.removeClass('successBg');
        x.addClass('failedBg');
    }
}

function getURLParameter(name) {
    return decodeURIComponent((new RegExp('[?|&]' + name + '=' + '([^&;]+?)(&|#|;|$)').exec(location.search)||[,""])[1].replace(/\+/g, '%20'))||null;
}

